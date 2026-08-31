// Inline PR-review block for the Tracked timeline (both layouts — mobile
// mounts the same drill-in). This module owns no separate view/tab;
// orchestrated-card.js mounts it directly inside the step's row once there's
// something to show, adapting the step's `pr` facts onto the flat shape read here.

import { groupThreads, renderThreadCard } from './thread-card.js';
import {
  isReplyDraft, renderReplyCallHtml, replyAcceptLabel, replyCallsByComment, wireReplyDraft,
} from './reply-draft.js';
import { draftDecisionHtml, draftEvidenceHtml, draftFeedbackHtml } from './write-draft-card.js';
import { openDiffForStep } from '../../app-bridge.js';
import { prPatches } from '../../state/pr-patches.js';
import { worktreeChanges } from '../../state/worktree-changes.js';
import { shortName } from '../../utils/formatting.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function ciBadge(s) {
  if (!s.ciState) return '';
  if (s.ciState === 'success') return '<span class="o-pill ok">CI ok</span>';
  if (s.ciState === 'failure') return '<span class="o-pill danger">CI fail</span>';
  return '<span class="o-pill">CI pending</span>';
}
function reviewBadge(s) {
  if (!s) return '';
  if (s === 'approved') return '<span class="o-pill ok">Approved</span>';
  if (s === 'changes_requested') return '<span class="o-pill review">Changes requested</span>';
  return '<span class="o-pill">Review required</span>';
}
// Mergeability is a distinct blocker from CI: a conflicting PR reads as "CI
// pending" but actually can't land. The controller owns the fix — its own
// code.resolve-conflicts round — so this is a status pill, not a CTA; the user's lever
// is the card's message composer. Clean/unknown stays silent.
function mergeBadge(s) {
  return s.mergeable === 'conflicting' ? '<span class="o-pill warn">Conflicts</span>' : '';
}

// The one control on the branch row. Geometric, single weight, 18-viewBox, currentColor —
// the same drawing contract as action-icon.js, so it inherits the button's text color.
const BRANCH_GLYPH = `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="4" r="1.9"/><circle cx="5" cy="14" r="1.9"/><circle cx="13" cy="4" r="1.9"/><path d="M5 5.9v6.2"/><path d="M13 5.9v1.1C13 9.6 5 8.6 5 11.2"/></svg>`;

// A review controller's workspace is a `readonly` detached checkout of somebody else's PR
// head — `s.sessionId` there is the controller's own persistent session id, set from turn 1
// and never unset, and says nothing about whether a diff exists (it never will: the checkout
// is clean by construction). Gate the diff button on ownership of the branch, not merely on
// having a session. `prIsClosed` also covers "closed but not merged" — there's nothing to
// review once the PR is dead either way.
function isMergedPr(s) { return s.state === 'merged' || s.prState === 'merged'; }
function prIsClosed(s) { return isMergedPr(s) || s.prState === 'closed'; }
function reviewReadyFor(s) { return !prIsClosed(s) && s.workspace?.kind !== 'readonly' && !!s.sessionId; }

// Accent-1 when the worktree is dirty, outlined otherwise. The variant is the whole message:
// a diff you can always open is not asking you for anything, but uncommitted work IS — it's
// the one thing in this card that can't move until the user looks at it, and the controller
// is typically parked waiting for exactly that. Until the count lands (or if it can't be
// read) the button stays outlined: unknown must not read as dirty.
function diffBtnHtml(s) {
  const changes = worktreeChanges.for(s.sessionId);
  const dirty = !!changes && changes.changed > 0;
  const title = dirty
    ? `${changes.changed} uncommitted ${changes.changed === 1 ? 'file' : 'files'} — review them`
    : `Review this branch's changes`;
  return `
    <button type="button" class="o-btn ${dirty ? 'o-btn--primary' : 'o-btn--default'} sm pr-diff-btn"
            data-diff-action="review" title="${escapeHtml(title)}">
      <span class="pr-diff-glyph">${BRANCH_GLYPH}</span>Review changes
    </button>`;
}

const CHECK_GLYPH = { success: '✓', failure: '✗', pending: '•', skipped: '⊘' };
const CHECK_RANK = { failure: 0, pending: 1, skipped: 2, success: 3 };
// Order + wording of the summary-line breakdown ("4 passing, 1 failed").
const CHECK_COUNT_WORDS = [['success', 'passing'], ['failure', 'failed'], ['pending', 'pending'], ['skipped', 'skipped']];

function checkRow(c) {
  return `
    <li class="pr-check pr-check--${c.state}">
      <span class="pr-check-dot" aria-hidden="true">${CHECK_GLYPH[c.state] ?? '•'}</span>
      <span class="pr-check-name">${escapeHtml(c.name)}</span>
      ${c.url ? `<a class="pr-check-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(c.name)}">↗</a>` : ''}
    </li>`;
}

function checkCountPhrase(checks) {
  const by = {};
  for (const c of checks) by[c.state] = (by[c.state] ?? 0) + 1;
  return CHECK_COUNT_WORDS.filter(([st]) => by[st]).map(([st, word]) => `${by[st]} ${word}`).join(', ');
}

// A chevron-labelled disclosure summary shared by the checks, resolved-comments
// and spec/plan lines: "▸ CHECKS · 4 passing, 1 failed". The count is optional —
// spec/plan carry no breakdown, just the label. The chevron is a summary ::before.
function disclosureSummary(label, count) {
  return `<summary>`
    + `<span class="o-microhead">${label}</span>`
    + (count
      ? `<span class="pr-disclosure-sep" aria-hidden="true">·</span>`
        + `<span class="pr-disclosure-count">${escapeHtml(count)}</span>`
      : '')
    + `</summary>`;
}

// Per-workflow CI list, one collapsible section. Expanded while the PR is live
// (checks are what you're watching); collapsed once it's merged/closed and the
// breakdown in the summary line is all you need.
function renderChecksHtml(s, prClosed) {
  const checks = s.ciChecks ?? [];
  if (!checks.length) return '';
  const sorted = [...checks].sort((a, b) =>
    (CHECK_RANK[a.state] ?? 9) - (CHECK_RANK[b.state] ?? 9) || a.name.localeCompare(b.name));
  return `
    <details class="pr-disclosure pr-checks"${prClosed ? '' : ' open'}>
      ${disclosureSummary('Checks', checkCountPhrase(sorted))}
      <ul class="pr-check-list">${sorted.map(checkRow).join('')}</ul>
    </details>`;
}

// A PR block is worth showing once there's a branch/PR/comment to talk about. The
// caller gates on phase first (orchestrated-card.js suppresses the whole block until
// the controller is past spec/plan, when nothing has touched the worktree yet).
export function hasPrBlock(s) {
  return !!(s.prUrl || s.workspace?.branch || (s.comments ?? []).length > 0);
}

export function renderPrBlockHtml(job, s, { replyDraft } = {}) {
  const drafts = new Map((s.draftedReplies ?? []).map((d) => [d.commentId, d]));
  const comments = s.comments ?? [];
  // The real per-file diffs, so each thread's excerpt can show the lines AFTER the comment —
  // the comment's own `diff_hunk` stops dead at it. Render-time read of whatever has landed;
  // the fetch is armed below and repaints through the prPatches store when it arrives.
  const patches = comments.some((c) => c.file) ? prPatches.for(job?.id, s.id) : null;
  const allThreads = groupThreads(comments);
  const isResolved = (chain) => !!chain[chain.length - 1].respondedAt;
  const draftFor = (chain) => {
    for (let i = chain.length - 1; i >= 0; i--) {
      const d = drafts.get(chain[i].id);
      if (d) return d;
    }
    return undefined;
  };

  // A pending `code.reply-pr-comments` draft renders as the reply composers it replaces — one
  // per thread — instead of as a stack of `gh api` commands in a generic approval card. The
  // decision is still the draft's own, taken once for all of them (there is one WriteDraft to
  // accept), so the whole threads region becomes that draft's `.wd-card`: wireWriteDraft finds
  // it by `data-draft-id` wherever it lives, and collectCalls reads the edited replies back off
  // the `.wd-call` fieldsets nested in the thread cards.
  const pendingReplies = isReplyDraft(replyDraft) ? replyDraft : null;
  const replyCalls = pendingReplies
    ? replyCallsByComment(pendingReplies, comments.map((c) => c.id))
    : new Map();
  const claimed = new Set();
  const hasReply = (chain) => chain.some((c) => replyCalls.has(c.id));
  // Keyed on the individual comment, not the thread: a reply belongs directly under the message
  // it answers, and a draft that answers two comments in one thread gets both, each in place.
  const replyForComment = (commentId) => {
    const hit = replyCalls.get(commentId);
    if (!hit) return '';
    claimed.add(hit.idx);
    return renderReplyCallHtml(pendingReplies, hit.call, hit.idx);
  };

  // A thread the controller wants to answer stays in the open list even if the watcher already
  // marked it responded — burying an unapproved reply inside the collapsed "resolved"
  // disclosure would hide a pending write behind a click.
  const openThreads = allThreads.filter((c) => !isResolved(c) || hasReply(c));
  const resolvedThreads = allThreads.filter((c) => isResolved(c) && !hasReply(c));

  const repoName = shortName(s.workspace?.repoCwd);
  const prMatch = s.prUrl ? s.prUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?\/pull\/(\d+)/) : null;
  const prRepo = prMatch ? prMatch[1] : repoName;
  const prNum = prMatch ? prMatch[2] : null;
  const isMerged = isMergedPr(s);
  const prClosed = prIsClosed(s);
  const reviewReady = reviewReadyFor(s);

  // Once merged, "Merged" (in the stats row) says it all — the CI/approval pills
  // are implied and just add noise to the collapsed line; the full check
  // breakdown still lives in the expandable Checks disclosure.
  const badges = isMerged ? [] : [mergeBadge(s), ciBadge(s), reviewBadge(s.reviewState)].filter(Boolean);

  // The two always-visible rows — repo/badges + branch/diff. When merged these become the
  // collapsed summary; otherwise they head the open block. No title row: `PrFacts` carries
  // no title of its own, so this printed `s.title` — the STEP's title, already the
  // `.tl-name` heading a few rows up. One string, rendered twice, in two typographies.
  //
  // The diff sits on the branch row, right-aligned under the pills, because that is what it
  // is about: this branch's changes. It used to be an accent-bordered banner of its own below
  // these rows — a permanent "Review the branch diff" + Discard + Review changes → that was
  // present on every live PR, so the loudest thing in the card was a standing offer rather
  // than anything that had happened. Discard is not lost, it moved one click in: the diff
  // overlay carries both "Discard all" and a per-file Discard, which is where you can
  // actually see what you're throwing away before you throw it.
  const header = `
    <div class="pr-hdr">
      ${s.prUrl
        ? `<a class="pr-num" href="${escapeHtml(s.prUrl)}" target="_blank" rel="noopener">${escapeHtml(prRepo)}${prNum ? ` #${escapeHtml(prNum)}` : ''} ↗</a>`
        : `<span class="pr-num">${escapeHtml(repoName)}</span>`}
      ${badges.length ? `<div class="pr-badges">${badges.join('')}</div>` : ''}
    </div>
    <div class="pr-stats">
      ${s.workspace?.branch ? `<span class="prb-branch">${escapeHtml(s.workspace.branch)}</span>` : ''}
      ${isMerged ? '<span class="pr-merged">Merged</span>' : ''}
      ${reviewReady ? diffBtnHtml(s) : ''}
    </div>`;

  // Order matters: `replyForComment` is what fills `claimed`, so the threads have to be
  // rendered before the leftovers can be worked out.
  const openThreadsHtml = openThreads
    .map((chain) => renderThreadCard(chain, draftFor(chain), replyForComment, patches))
    .join('');
  // A drafted reply whose `label` names no comment on this PR — a deleted comment, or an id
  // the action got wrong. It still posts if accepted, so it gets the same treatment (and the
  // same per-reply skip) out here rather than being silently omitted from the payload the user
  // is approving; it just names its own target, since no thread is doing that for it.
  const unclaimedHtml = (pendingReplies?.calls ?? [])
    .map((c, i) => (claimed.has(i) ? '' : renderReplyCallHtml(pendingReplies, c, i, { label: c.label || 'an unknown comment' })))
    .join('');

  // The open threads get the same "LABEL · count" heading the Checks and resolved-comments
  // disclosures carry, so the three regions of the block announce themselves the same way —
  // except under a pending reply draft, where the draft's own `wd-head` already names it.
  const openHdr = pendingReplies ? '' : `
    <div class="pr-threads-hdr">
      <span class="o-microhead">Comments</span>
      <span class="pr-disclosure-sep" aria-hidden="true">·</span>
      <span class="pr-disclosure-count">${openThreads.length} open</span>
    </div>`;
  const threadsHtml = openThreadsHtml ? `${openHdr}<ul class="threads">${openThreadsHtml}</ul>` : '';
  const threadsRegion = !pendingReplies ? threadsHtml : `
    <div class="wd-card wd-card--replies" data-draft-id="${escapeHtml(pendingReplies.id)}">
      <div class="wd-head">⚠ ${escapeHtml(pendingReplies.summary)}</div>
      <div class="wd-subhead">Edit any reply in place, or ignore the ones that don't need one. Nothing is posted until you accept.</div>
      ${draftFeedbackHtml(pendingReplies)}
      ${threadsHtml}
      ${unclaimedHtml ? `<div class="wd-calls pr-reply-unclaimed">${unclaimedHtml}</div>` : ''}
      ${draftEvidenceHtml(pendingReplies)}
      ${draftDecisionHtml(pendingReplies, {
    // Denying the whole draft isn't a verdict that fits here: once there are new comments,
    // drafting replies was the right move — the answer to "not this one" is its skip box, and
    // to "none of these" is ticking them all, which the daemon settles as its own outcome.
    deny: false,
    acceptLabel: replyAcceptLabel(pendingReplies.calls.length, 0),
  })}
    </div>`;

  // Everything under the header, in chronological order: open threads
  // (live/actionable, so kept up top) → checks → resolved comments. Spec and
  // implementation plan are artifacts of the step, not of the PR — the orchestrated
  // card discloses them once, above this block, where the controller produced them.
  const body = `
    ${threadsRegion}
    ${renderChecksHtml(s, prClosed)}
    ${resolvedThreads.length ? `
      <details class="pr-disclosure pr-threads-resolved">
        ${disclosureSummary('Comments', `${resolvedThreads.length} resolved`)}
        <ul class="threads">
          ${resolvedThreads.map((chain) => renderThreadCard(chain, undefined, undefined, patches)).join('')}
        </ul>
      </details>
    ` : ''}`;

  // Once merged, the whole block folds to its two header rows — a done PR reads
  // as one quiet line, expandable to revisit the trail. Collapsed by default:
  // the outer <details> renders without `open`, and detail.js's open-state
  // persistence has no prior entry on the first paint after the merge.
  if (isMerged) {
    return `
      <details class="pr-block pr-block--merged" data-step-id="${escapeHtml(s.id)}">
        <summary class="pr-block-summary">
          <div class="pr-summary-rows">${header}</div>
          <span class="pr-block-caret" aria-hidden="true">▸</span>
        </summary>
        <div class="pr-block-body">${body}</div>
      </details>
    `;
  }

  return `
    <div class="pr-block" data-step-id="${escapeHtml(s.id)}">
      ${header}
      ${body}
    </div>
  `;
}

export function wirePrBlockActions(el, job, s, { replyDraft } = {}) {
  if (isReplyDraft(replyDraft)) wireReplyDraft(el, replyDraft);
  // Armed here rather than at render time: rendering runs on every repaint, and `ensure` is
  // the thing that must decide once per head sha whether a fetch is owed.
  if (job?.id && (s.comments ?? []).some((c) => c.file)) prPatches.ensure(job.id, s.id, s.headRefOid);
  // Same reason, one step further: the count decides the diff button's variant, and only a
  // read of the worktree can answer it. Keyed on `updatedAt`, so the round that commits the
  // edits is what re-reads — see state/worktree-changes.js.
  if (reviewReadyFor(s)) worktreeChanges.ensure(s.sessionId, s.updatedAt);
  el.querySelector('[data-diff-action="review"]')?.addEventListener('click', () => {
    void openDiffForStep({ jobId: job.id, stepId: s.id, sessionId: s.sessionId });
  });
}
