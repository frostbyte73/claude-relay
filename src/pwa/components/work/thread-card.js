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

function renderDiffHunk(hunk) {
  return String(hunk).split('\n').map((line) => {
    const cls = line.startsWith('+') ? 'hunk-add'
      : line.startsWith('-') ? 'hunk-del'
      : line.startsWith('@@') ? 'hunk-hdr'
      : 'hunk-ctx';
    return `<span class="${cls}">${escapeHtml(line) || ' '}</span>`;
  }).join('');
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

function confidencePill(confidence) {
  if (!confidence) return '';
  return `<span class="thread-confidence thread-confidence-${confidence}">confidence: ${escapeHtml(confidence)}</span>`;
}

export function renderThreadCard(chain, draft, replyHtmlFor = () => '') {
  const root = chain[0];
  const leaf = chain[chain.length - 1];
  const loc = root.file ? (root.line ? `${root.file}:${root.line}` : root.file) : 'general comment';
  const recClass = draft?.recommendation ? ` thread-has-${draft.recommendation}` : '';
  const replies = chain.map((c) => replyHtmlFor(c.id) || '');
  return `
    <li class="thread${recClass}${replies.some(Boolean) ? ' thread--replying' : ''}" data-comment-id="${escapeHtml(leaf.id)}">
      <article class="thread-card">
        <header class="thread-header">
          <span class="thread-loc">${escapeHtml(loc)}</span>
          <span class="thread-author">${escapeHtml(root.author ?? 'unknown')}</span>
          <span class="thread-time">${escapeHtml(relTime(root.createdAt))}</span>
          ${recPill(draft?.recommendation)}
          ${confidencePill(draft?.confidence)}
        </header>
        ${root.diffHunk ? `<pre class="thread-hunk">${renderDiffHunk(root.diffHunk)}</pre>` : ''}
        ${chain.map((c, i) => `
          <div class="thread-msg">
            <div class="thread-msg-head">
              <span class="thread-avatar">${escapeHtml(initials(c.author))}</span>
              <span class="thread-author">${escapeHtml(c.author ?? 'unknown')}</span>
              <span class="thread-msg-meta">${escapeHtml(relTime(c.createdAt))}</span>
            </div>
            <div class="thread-msg-body markdown">${renderMarkdown(stripHtmlComments(c.body), { allowHtml: true })}</div>
          </div>
          ${replies[i]}
        `).join('')}
        ${reactionsStrip(chain)}
        ${draft?.rationale ? `<p class="thread-rationale">${escapeHtml(draft.rationale)}</p>` : ''}
      </article>
    </li>
  `;
}
