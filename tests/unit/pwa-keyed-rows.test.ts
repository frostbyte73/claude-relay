// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { reconcileKeyedRows, resetKeyedRows, placeKeyedNodes, setHtmlIfChanged } from '../../src/pwa/utils/keyed-rows.js';

type Row = { key: string; html: string };

function row(key: string, text = key): Row {
  return { key, html: `<div class="msg" data-k="${key}">${text}</div>` };
}

function keys(el: HTMLElement) {
  return [...el.children].map((c) => (c as HTMLElement).dataset.k);
}

describe('reconcileKeyedRows', () => {
  it('reuses the node of an unchanged row and only replaces the changed one', () => {
    const el = document.createElement('div');
    reconcileKeyedRows(el, [row('a'), row('b'), row('c')]);
    const [a, b, c] = [...el.children];

    reconcileKeyedRows(el, [row('a'), row('b', 'edited'), row('c')]);

    expect(el.children[0]).toBe(a);
    expect(el.children[2]).toBe(c);
    expect(el.children[1]).not.toBe(b);
    expect(el.children[1]?.textContent).toBe('edited');
  });

  it('appends without touching existing nodes — the live-transcript case', () => {
    const el = document.createElement('div');
    reconcileKeyedRows(el, [row('a'), row('b')]);
    const before = [...el.children];

    reconcileKeyedRows(el, [row('a'), row('b'), row('c')]);

    expect([...el.children].slice(0, 2)).toEqual(before);
    expect(keys(el)).toEqual(['a', 'b', 'c']);
  });

  it('drops rows that disappear, including from the middle', () => {
    const el = document.createElement('div');
    reconcileKeyedRows(el, [row('a'), row('b'), row('c')]);
    const c = el.children[2];

    reconcileKeyedRows(el, [row('a'), row('c')]);

    expect(keys(el)).toEqual(['a', 'c']);
    expect(el.children[1]).toBe(c);
  });

  it('reorders by moving existing nodes rather than rebuilding them', () => {
    const el = document.createElement('div');
    reconcileKeyedRows(el, [row('a'), row('b'), row('c')]);
    const [a, b, c] = [...el.children];

    reconcileKeyedRows(el, [row('c'), row('a'), row('b')]);

    expect(keys(el)).toEqual(['c', 'a', 'b']);
    expect([...el.children]).toEqual([c, a, b]);
  });

  it('survives a transcript trim, where every row shifts position', () => {
    const el = document.createElement('div');
    const all = ['a', 'b', 'c', 'd'].map((k) => row(k));
    reconcileKeyedRows(el, all);
    const kept = [...el.children].slice(1);

    reconcileKeyedRows(el, all.slice(1));

    expect(keys(el)).toEqual(['b', 'c', 'd']);
    expect([...el.children]).toEqual(kept);
  });

  it('handles rows that render to nothing or to several siblings', () => {
    const el = document.createElement('div');
    reconcileKeyedRows(el, [
      row('a'),
      { key: 'empty', html: '   ' },
      { key: 'pair', html: '<div class="msg" data-k="p1"></div>\n<div class="msg" data-k="p2"></div>' },
    ]);

    expect(keys(el)).toEqual(['a', 'p1', 'p2']);

    reconcileKeyedRows(el, [row('a')]);
    expect(keys(el)).toEqual(['a']);
  });

  it('starts clean after a reset so stale nodes are not re-inserted', () => {
    const el = document.createElement('div');
    reconcileKeyedRows(el, [row('a'), row('b')]);
    resetKeyedRows(el);
    expect(el.children.length).toBe(0);

    reconcileKeyedRows(el, [row('a')]);
    expect(keys(el)).toEqual(['a']);
  });

  it('places caller-owned nodes without ever replacing them', () => {
    const el = document.createElement('div');
    const nodes = ['a', 'b', 'c'].map((k) => {
      const n = document.createElement('div');
      n.dataset.k = k;
      return { key: k, node: n };
    });
    placeKeyedNodes(el, nodes);
    expect(keys(el)).toEqual(['a', 'b', 'c']);

    // Reorder + drop, with the caller's own node objects reused throughout.
    const [a, , c] = nodes;
    placeKeyedNodes(el, [c, a]);
    expect(keys(el)).toEqual(['c', 'a']);
    expect(el.children[0]).toBe(c!.node);
    expect(el.children[1]).toBe(a!.node);
  });

  it('setHtmlIfChanged skips the rewrite when the markup is identical', () => {
    const el = document.createElement('div');
    expect(setHtmlIfChanged(el, '<span class="dot"></span>')).toBe(true);
    const dot = el.firstElementChild;

    expect(setHtmlIfChanged(el, '<span class="dot"></span>')).toBe(false);
    expect(el.firstElementChild).toBe(dot);

    expect(setHtmlIfChanged(el, '<span class="dot other"></span>')).toBe(true);
    expect(el.firstElementChild).not.toBe(dot);
  });

  it('preserves focus and caret inside a row it did not have to re-render', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const withField = { key: 'card', html: '<div class="msg" data-k="card"><textarea>hello</textarea></div>' };
    reconcileKeyedRows(el, [row('a'), withField]);
    const ta = el.querySelector('textarea')!;
    ta.focus();
    ta.setSelectionRange(2, 4);

    reconcileKeyedRows(el, [row('a', 'changed'), withField]);

    expect(document.activeElement).toBe(ta);
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
    el.remove();
  });
});
