// Keyed row reconciler for append-mostly feeds that render each row to an HTML
// string.
//
// The session transcript used to paint as one `innerHTML` assignment: every
// store tick tore the whole feed down and re-parsed it, so a paint cost
// O(entire transcript) in HTML parsing, style recalc and layout no matter how
// little changed. Coalescing paints to one per frame bounded how OFTEN that
// happened but not what it cost, and the cost scales with the session — a
// session with ~60 subagents paints a megabyte of markup per frame, which pegs
// the main thread and stops the tab responding to input at all.
//
// Reconciling by key keeps the nodes of unchanged rows exactly where they are,
// so a paint touches only what actually changed. Row identity is the caller's
// `key`; `html` is compared verbatim, so a row whose markup is byte-identical is
// left alone — which also preserves focus, caret, text selection and scroll
// anchoring inside it for free.
//
// Rows may render to zero nodes (a message that strips to nothing) or several
// (a renderer that returns sibling elements); both are handled.

function parseNodes(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // Whitespace between rows is layout-inert here (rows are blocks) and only
  // exists because some renderers use indented template literals — dropping it
  // keeps the reconciler's node bookkeeping 1:1 with real rows.
  return Array.from(tpl.content.childNodes)
    .filter((n) => n.nodeType !== Node.TEXT_NODE || n.nodeValue.trim() !== '');
}

// Reconcile `container`'s children against `rows` ([{key, html}], in display
// order). Returns nothing; state rides on the container so callers stay
// stateless.
export function reconcileKeyedRows(container, rows) {
  const prev = container.__keyedRows instanceof Map ? container.__keyedRows : new Map();
  const entries = [];
  const reused = new Set();
  for (const row of rows) {
    const was = prev.get(row.key);
    // Byte-identical markup → keep the existing nodes untouched.
    if (was && was.html === row.html) {
      reused.add(row.key);
      entries.push({ key: row.key, ...was });
      continue;
    }
    const nodes = parseNodes(row.html);
    if (nodes.length === 0) continue;
    entries.push({ key: row.key, html: row.html, nodes });
  }
  // Detach what isn't being reused BEFORE placing, so the placement walk finds
  // the surviving nodes already in their relative order and doesn't have to
  // shuffle every row after a changed one.
  for (const [key, was] of prev) {
    if (reused.has(key)) continue;
    for (const node of was.nodes) node.remove();
  }
  placeKeyedNodes(container, entries);
}

// Ordering half, for callers that own their nodes and patch them in place
// instead of re-rendering to a string. `entries` is [{key, nodes}] (or
// {key, node}) in display order; anything previously placed and now absent is
// removed. Patching in place is what lets a CSS animation survive a repaint —
// a re-created element restarts its keyframes from zero, which is why the
// session list's pulsing dots all reset on every unrelated store tick.
export function placeKeyedNodes(container, entries) {
  const next = new Map();
  // Everything at or after `cursor` is still unclaimed. Reused nodes get moved
  // to the cursor, so once the loop ends the tail from `cursor` on is stale.
  let cursor = container.firstChild;

  for (const entry of entries) {
    const nodes = entry.nodes ?? [entry.node];
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else container.insertBefore(node, cursor);
    }
    next.set(entry.key, { html: entry.html, nodes });
  }

  while (cursor) {
    const after = cursor.nextSibling;
    cursor.remove();
    cursor = after;
  }
  container.__keyedRows = next;
}

// Drop both the DOM and the bookkeeping — for callers that replace the
// container's contents wholesale (empty states, "loading…"), so the next
// reconcile starts from a known-empty container rather than re-inserting nodes
// it still believes are mounted.
export function resetKeyedRows(container) {
  container.__keyedRows = new Map();
  container.textContent = '';
}

// Single-region version of the same idea: rewrite only when the markup actually
// changed. For regions repainted on a ticker or on every store tick whose
// content rarely differs — an unconditional assignment re-creates the subtree,
// which restarts any CSS animation inside it. Returns whether it wrote.
export function setHtmlIfChanged(el, html) {
  if (el.__lastHtml === html) return false;
  el.__lastHtml = html;
  el.innerHTML = html;
  return true;
}
