// How a proposed or recorded change to a SKILL.md renders. Two shapes, picked by whether
// there was a prior body: a revision reads as a diff (shared with the revision-history rows),
// while a brand-new action is a file creation — an all-`+` diff of a file nobody has seen is
// just the file with a column of plus signs in front of it, so it renders as the file.

import { escapeHtml } from '../../util.js';
import { bytesText, revisionDiffLines } from '../../vm/library.js';

// A change small enough to read at a glance opens without a click; a rewrite stays folded
// so it can't bury the approve buttons.
const AUTO_OPEN_LINES = 40;

export function skillDiffHtml(diff, { label = 'View diff', suffix = '', defaultOpen = false } = {}) {
  // The `diff --git`/`---`/`+++` preamble is noise here — the block is already scoped to one
  // action's SKILL.md. It stays in the wire format so the diff parses as git output.
  const lines = revisionDiffLines(diff).filter((l) => l.cls !== 'meta');
  if (lines.length === 0) return '';
  const body = lines
    .map((l) => `<div class="lib-diff-line ${l.cls}">${escapeHtml(l.text)}</div>`)
    .join('');
  return wrap(label, suffix, defaultOpen && lines.length <= AUTO_OPEN_LINES, `<div class="lib-diff-lines">${body}</div>`);
}

export function skillBodyHtml(text, { label = 'SKILL.md', defaultOpen = false } = {}) {
  if (!text) return '';
  const lineCount = text.replace(/\n$/, '').split('\n').length;
  const suffix = ` · ${bytesText(text.length)}`;
  return wrap(label, suffix, defaultOpen && lineCount <= AUTO_OPEN_LINES, `<pre class="lib-diff-body">${escapeHtml(text)}</pre>`);
}

function wrap(label, suffix, open, inner) {
  return `
    <details class="lib-diff"${open ? ' open' : ''}>
      <summary>${escapeHtml(label)}${suffix}</summary>
      ${inner}
    </details>
  `;
}

