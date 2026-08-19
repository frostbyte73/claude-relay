// Read-only record of a PR review thread. Replying, reacting, and queueing a
// per-comment edit all went away with the `open-pr` step type — the controller
// owns those moves now — but jobs migrated from it still carry the comments and
// drafted replies (see storage/jobs-migrate.ts), so the history stays rendered.
//
// The one live thing a thread can carry is a drafted reply: `replyHtmlFor(commentId)` is a slot
// pr-block.js fills with the pending write draft's field for that specific comment
// (reply-draft.js), rendered directly beneath it so the reply reads as the answer to the
// message above it rather than as a footnote at the end of the thread. This module stays
// read-only either way — it renders what it's handed and owns no controls of its own.
import { renderMarkdown } from '../../markdown.js';
import { windowForComment } from '../../utils/diff-window.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function initials(name) {
  const s = String(name ?? '').trim();
  if (!s) return '?';
  const parts = s.split(/[-_\s]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function relTime(epochMs) {
  if (!epochMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const OP_CLASS = { '+': 'hunk-add', '-': 'hunk-del', ' ': 'hunk-ctx' };

function hunkRow(row, isAnchor) {
  const num = row.newLine ?? row.oldLine ?? '';
  return `<span class="${OP_CLASS[row.op] ?? 'hunk-ctx'}${isAnchor ? ' hunk-anchor' : ''}">`
    + `<span class="hunk-num" aria-hidden="true">${num}</span>`
    + `<span class="hunk-code">${escapeHtml(row.op + row.content) || ' '}</span>`
    + '</span>';
}

// How far an expander reaches. A collapsed <details> still costs its full markup in every
// repaint's innerHTML — that is what made a busy job's timeline stutter once before — so the
// rest of a 581-row hunk does NOT get rendered just in case. Twenty lines is what "show me a
// bit more" means; past that the thread's ↗ link to GitHub is the honest answer.
const EXPAND_MAX = 20;

// `data-details-key` because every thread in a step's PR block renders one of these with the
// same class — detail.js's repaint snapshot would otherwise key them all alike and reopen the
// lot when the user had opened one.
function elisionHtml(hidden, where, rowsHtml, commentId) {
  const shown = Math.min(hidden, EXPAND_MAX);
  return `
    <details class="hunk-more hunk-more--${where}" data-details-key="hunk-${where}-${escapeHtml(commentId)}">
      <summary><span class="hunk-num" aria-hidden="true">⋯</span><span class="hunk-code">${shown} more line${shown === 1 ? '' : 's'} ${where}${hidden > shown ? ` (of ${hidden})` : ''}</span></summary>
      ${rowsHtml}
    </details>`;
}

// The excerpt under the thread header. GitHub's `diff_hunk` is the wrong slice to render
// verbatim — see utils/diff-window.js — so `win` decides what to show and this only draws it.
function renderHunkWindow(win, commentId) {
  const row = (i) => hunkRow(win.rows[i], i === win.anchor);
  const range = (from, to) => { const out = []; for (let i = from; i < to; i++) out.push(row(i)); return out.join(''); };

  const beforeCount = win.start;
  const before = beforeCount > 0
    ? elisionHtml(beforeCount, 'above', range(Math.max(0, win.start - EXPAND_MAX), win.start), commentId)
    : '';
  const afterCount = win.rows.length - win.end;
  const after = afterCount > 0
    ? elisionHtml(afterCount, 'below', range(win.end, Math.min(win.rows.length, win.end + EXPAND_MAX)), commentId)
    : '';
  const header = `<span class="hunk-hdr"><span class="hunk-num" aria-hidden="true"></span>`
    + `<span class="hunk-code">${escapeHtml(win.section || win.header)}</span></span>`;
  return `<div class="thread-hunk">${header}${before}${range(win.start, win.end)}${after}</div>`;
}

function stripHtmlComments(body) {
  return String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function groupThreads(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const roots = [];
  const childrenOf = new Map();
  for (const c of comments) {
    if (c.inReplyTo && byId.has(c.inReplyTo)) {
      const arr = childrenOf.get(c.inReplyTo) ?? [];
      arr.push(c);
      childrenOf.set(c.inReplyTo, arr);
    } else {
      roots.push(c);
    }
  }
  const out = [];
  for (const root of roots) {
    const chain = [root];
    const queue = [...(childrenOf.get(root.id) ?? [])];
    while (queue.length) {
      const next = queue.shift();
      chain.push(next);
      queue.push(...(childrenOf.get(next.id) ?? []));
    }
    chain.sort((a, b) => a.createdAt - b.createdAt);
    out.push(chain);
  }
  return out;
}

const REACTION_EMOJI = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
};

function reactionsStrip(chain) {
  const have = chain[0].userReactions ?? [];
  if (!have.length) return '';
  const chips = have.map((c) => `<span class="thread-reaction-chip" title="${escapeHtml(c)}">${REACTION_EMOJI[c] ?? '?'}</span>`).join('');
  return `
    <div class="thread-reactions">
      <div class="thread-reaction-chips">${chips}</div>
    </div>
  `;
}

function recPill(rec) {
  if (!rec) return '';
  const labels = { reply: 'Reply', edit: 'Edit', ignore: 'Ignore' };
  return `<span class="thread-rec thread-rec-${rec}">${labels[rec]}</span>`;
}

const REC_WHY = { reply: 'Why reply', edit: 'Why edit', ignore: 'Why ignore' };

// The card's footer: what the triage concluded and how sure it is. Confidence used to sit up in
// the header beside the file path, where it read as a fact about the thread; it's a fact about
// the assessment, so it belongs next to the reasoning it qualifies.
function rationaleHtml(draft) {
  if (!draft?.rationale && !draft?.confidence) return '';
  return `
    <footer class="thread-rationale">
      <div class="thread-rationale-head">
        <span class="o-microhead">${REC_WHY[draft.recommendation] ?? 'Assessment'}</span>
        ${draft.confidence
    ? `<span class="thread-confidence thread-confidence-${draft.confidence}">${escapeHtml(draft.confidence)} confidence</span>`
    : ''}
      </div>
      ${draft.rationale ? `<p class="thread-rationale-text">${escapeHtml(draft.rationale)}</p>` : ''}
    </footer>`;
}

// One message on the thread's avatar spine. The avatar is a direct grid child rather than a
// member of the head row so the gutter is a real column every message shares — that column IS
// the thread, and the 2px rail drawn down it is what makes a reply read as a reply. Reactions
// belong to the root comment (that's the only one the watcher records them for), so they render
// against its body instead of floating at the end of the chain.
function messageHtml(c, { first, last, reactions }) {
  return `
    <div class="thread-msg${first ? ' thread-msg--root' : ' thread-msg--reply'}${last ? ' thread-msg--last' : ''}">
      <span class="thread-avatar" aria-hidden="true">${escapeHtml(initials(c.author))}</span>
      <div class="thread-msg-main">
        <div class="thread-msg-head">
          <span class="thread-author">${escapeHtml(c.author ?? 'unknown')}</span>
          <span class="thread-msg-meta">${escapeHtml(relTime(c.createdAt))}</span>
        </div>
        <div class="thread-msg-body markdown">${renderMarkdown(stripHtmlComments(c.body), { allowHtml: true })}</div>
        ${reactions}
      </div>
    </div>`;
}

export function renderThreadCard(chain, draft, replyHtmlFor = () => '', patches = null) {
  const root = chain[0];
  const win = windowForComment({
    patch: root.file ? patches?.[root.file] : undefined,
    diffHunk: root.diffHunk,
    line: root.line,
    startLine: root.startLine,
    side: root.side,
  });
  const leaf = chain[chain.length - 1];
  const loc = root.file ? (root.line ? `${root.file}:${root.line}` : root.file) : 'PR conversation';
  const recClass = draft?.recommendation ? ` thread-has-${draft.recommendation}` : '';
  const replies = chain.map((c) => replyHtmlFor(c.id) || '');
  const reactions = reactionsStrip(chain);
  // The header carries only what the thread is ABOUT — the location, and the triage verdict on
  // it. Author and time used to print here too, then again 10px below in the first message's
  // own head: one string, two typographies. The message row is where they belong. No reply
  // count either: the messages are right there on the spine, already counted.
  return `
    <li class="thread${recClass}${replies.some(Boolean) ? ' thread--replying' : ''}" data-comment-id="${escapeHtml(leaf.id)}">
      <article class="thread-card">
        <header class="thread-header">
          ${root.url
    ? `<a class="thread-loc" href="${escapeHtml(root.url)}" target="_blank" rel="noopener">${escapeHtml(loc)} ↗</a>`
    : `<span class="thread-loc">${escapeHtml(loc)}</span>`}
          ${recPill(draft?.recommendation)}
        </header>
        ${win ? renderHunkWindow(win, root.id) : ''}
        <div class="thread-body">
          ${chain.map((c, i) => messageHtml(c, {
    first: i === 0,
    last: i === chain.length - 1,
    reactions: i === 0 ? reactions : '',
  }) + replies[i]).join('')}
        </div>
        ${rationaleHtml(draft)}
      </article>
    </li>
  `;
}
