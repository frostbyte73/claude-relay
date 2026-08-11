// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
// @ts-expect-error PWA modules are plain JS; tests import them at runtime.
import { toolUseHtml, editWriteTileHtml } from '../../src/pwa/components/tool-use-tile.js';

// A collapsed tile hides its payload with CSS, so emitting the payload anyway put
// it in the DOM invisibly — and an `Agent` call's payload is the subagent's whole
// prompt, which is what made a session with ~60 subagents unpaintable. These pin
// that the payload is gone while collapsed but the tap-to-expand affordance (and
// the payload itself, once expanded) survives.

const AGENT = {
  role: 'tool_use',
  toolName: 'Agent',
  toolUseId: 'toolu_1',
  toolInput: { description: 'audit the allowlist', prompt: 'SECRET_PROMPT_MARKER — do the thing' },
  text: '',
};

const EDIT = {
  role: 'tool_use',
  toolName: 'Edit',
  toolUseId: 'toolu_2',
  toolInput: { file_path: '/tmp/x.ts', old_string: 'OLD_MARKER', new_string: 'NEW_MARKER' },
  text: '',
};

describe('tool tiles keep their payload out of the DOM while collapsed', () => {
  it('omits an Agent prompt when collapsed and includes it when expanded', () => {
    const collapsed = toolUseHtml(AGENT, { expandedTools: new Set(), ctx: {} });
    expect(collapsed).not.toContain('SECRET_PROMPT_MARKER');

    const expanded = toolUseHtml(AGENT, { expandedTools: new Set(['toolu_1']), ctx: {} });
    expect(expanded).toContain('SECRET_PROMPT_MARKER');
  });

  it('keeps the tap-to-expand affordance on the collapsed tile', () => {
    const collapsed = toolUseHtml(AGENT, { expandedTools: new Set(), ctx: {} });
    expect(collapsed).toContain('tool_use-expandable');
    expect(collapsed).toContain('data-tool-id="toolu_1"');
    expect(collapsed).toContain('tool-chev');
    expect(collapsed).not.toContain('tool_use-expanded');
  });

  it('applies the same rule to the Edit/Write diff body', () => {
    const collapsed = editWriteTileHtml(EDIT, { expandedTools: new Set(), ctx: {} });
    expect(collapsed).not.toContain('OLD_MARKER');
    expect(collapsed).toContain('tool_use-expandable');

    const expanded = editWriteTileHtml(EDIT, { expandedTools: new Set(['toolu_2']), ctx: {} });
    expect(expanded).toContain('OLD_MARKER');
    expect(expanded).toContain('NEW_MARKER');
  });

  it('still renders an alwaysExpanded tool statically — no id, no toggle needed', () => {
    const grep = toolUseHtml(
      { role: 'tool_use', toolName: 'Grep', toolUseId: 'toolu_3', toolInput: { pattern: 'GREP_MARKER' }, text: '' },
      { expandedTools: new Set(), ctx: {} },
    );
    expect(grep).toContain('GREP_MARKER');
    expect(grep).not.toContain('tool_use-expandable');
  });
});
