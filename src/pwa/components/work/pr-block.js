// Inline PR-review block for the Tracked timeline (both layouts — mobile
// mounts the same drill-in). This module owns no separate view/tab;
// step-card.js's timeline mounts it directly inside the open-pr step's row
// once there's something to show.

import { groupThreads, renderThreadCard, wireThreadCard } from './thread-card.js';
import { openDiffForStep } from '../../app-bridge.js';
import { discardAll } from '../../state/git.js';
import { work } from '../../state/work.js';
import { renderMarkdown } from '../../markdown.js';

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function shortName(cwd) { const p = String(cwd ?? '').split('/').filter(Boolean); return p.slice(-2).join('/'); }

function ciBadge(s) {
  // ciFixing/ciFixGaveUp take precedence over the plain ciState pill — they
  // describe what the auto-fixer is doing about a failure, not just the failure.
  if (s.ciFixing) return '<span class="o-pill warn">Fixing CI…</span>';
  if (s.ciFixGaveUp && s.ciState === 'failure') return '<span class="o-pill danger">CI failing — auto-fix stopped</span>';
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
// pending" but actually needs the operator to resolve conflicts — warn ("your
// move"). Clean/unknown stays silent. Once the engine has picked up the
// conflict (conflictResolving, or state flipped to conflicting/conflict_unresolved)
// the stateful conflictCtaHtml() block below takes over and this pill steps aside —
// it only covers the transient window between pr-watcher noticing and the state flip.
function mergeBadge(s) {
  if (s.mergeable === 'conflicting' && !s.conflictResolving && s.state !== 'conflicting' && s.state !== 'conflict_unresolved') {
    return '<span class="o-pill warn">Conflicts</span>';
  }
  return '';
}

// Stateful conflict UI, by precedence: a resolve round in flight, a round that
// gave up (manual fallback), or a fresh conflict waiting on the gate. Mirrors
// the pr-review-cta box/button shapes used by the discard/review-changes CTA above.
function conflictCtaHtml(s) {
  if (s.conflictResolving) {
    return `
      <div class="pr-conflict-busy">
        <button type="button" class="o-btn o-btn--default" disabled>
          <span class="pr-conflict-spin" aria-hidden="true"></span>Resolving conflicts…
        </button>
      </div>`;
  }
  if (s.state === 'conflict_unresolved') {
    return `<div class="pr-conflict-warn"><span class="o-pill warn">Couldn't auto-resolve — resolve manually</span></div>`;
  }
  if (s.state === 'conflicting') {
    return `
      <div class="pr-review-cta pr-conflict-cta--warn">
        <span class="pr-review-cta-label">Merge conflicts with main</span>
        <div class="pr-review-cta-actions">
          <button type="button" class="o-btn o-btn--default" data-pr-action="reject-conflicts">I'll do it</button>
          <button type="button" class="o-btn o-btn--primary" data-pr-action="resolve-conflicts">Resolve conflicts &amp; push</button>
        </div>
      </div>`;
  }
  return '';
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

// Spec and implementation plan are the paper trail the PR grew out of — they
// predate the checks/comments, so they fold in above them as collapsed
// reference. Distinct classes (pr-spec / pr-implplan) so detail.js's per-details
// open-state persistence keys them apart. Never auto-opened here: by the time a
// branch/PR exists the spec gate has passed, so these are history, not a review.
function docDisclosureHtml(label, cls, md) {
  if (!md) return '';
  return `
    <details class="pr-disclosure ${cls}">
      ${disclosureSummary(label)}
      <div class="step-findings md-body">${md}</div>
    </details>`;
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

// A PR block is worth showing once there's a branch/PR/comment to talk about —
// not during speccing/spec_pending_review/planning, when the shared session is
// live but hasn't touched the worktree yet (nothing to review). Those states
// render as a plain timeline row via step-card.js instead.
const PRE_IMPLEMENT_STATES = new Set(['speccing', 'spec_pending_review', 'planning']);

export function hasPrBlock(s) {
  if (PRE_IMPLEMENT_STATES.has(s.state)) return false;
  return !!(s.prUrl || s.workspace?.branch || (s.comments ?? []).length > 0);
}

export function renderPrBlockHtml(job, s) {
  const drafts = new Map((s.draftedReplies ?? []).map((d) => [d.commentId, d]));
  const comments = s.comments ?? [];
  const allThreads = groupThreads(comments);
  const isResolved = (chain) => !!chain[chain.length - 1].respondedAt;
  const openThreads = allThreads.filter((c) => !isResolved(c));
  const resolvedThreads = allThreads.filter(isResolved);
  const draftFor = (chain) => {
    for (let i = chain.length - 1; i >= 0; i--) {
      const d = drafts.get(chain[i].id);
      if (d) return d;
    }
    return undefined;
  };

  const repoName = shortName(s.workspace?.repoCwd);
  const prMatch = s.prUrl ? s.prUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?\/pull\/(\d+)/) : null;
  const prRepo = prMatch ? prMatch[1] : repoName;
  const prNum = prMatch ? prMatch[2] : null;
  const isMerged = s.state === 'merged' || s.prState === 'merged';
  const prClosed = isMerged || s.prState === 'closed';
  const reviewReady = !isMerged && !!s.sessionId;

  const spec = s.spec ? renderMarkdown(s.spec) : '';
  const implPlan = s.implPlan ? renderMarkdown(s.implPlan) : '';
  // Once merged, "Merged" (in the stats row) says it all — the CI/approval pills
  // are implied and just add noise to the collapsed line; the full check
  // breakdown still lives in the expandable Checks disclosure.
  const badges = isMerged ? [] : [mergeBadge(s), ciBadge(s), reviewBadge(s.reviewState)].filter(Boolean);

  // The two always-visible rows — repo/title/badges + branch/merged. When merged
  // these become the collapsed summary; otherwise they head the open block.
  const header = `
    <div class="pr-hdr">
      ${s.prUrl
        ? `<a class="pr-num" href="${escapeHtml(s.prUrl)}" target="_blank" rel="noopener">${escapeHtml(prRepo)}${prNum ? ` #${escapeHtml(prNum)}` : ''} ↗</a>`
        : `<span class="pr-num">${escapeHtml(repoName)}</span>`}
      <span class="prb-title">${escapeHtml(s.title)}</span>
      ${badges.length ? `<div class="pr-badges">${badges.join('')}</div>` : ''}
    </div>
    <div class="pr-stats">
      ${s.workspace?.branch ? `<span class="prb-branch">${escapeHtml(s.workspace.branch)}</span>` : ''}
      ${isMerged ? '<span class="pr-merged">Merged</span>' : ''}
    </div>`;

  // Everything under the header, in chronological order: CTAs and open threads
  // (live/actionable, so kept up top) → spec → plan → checks → resolved comments.
  const body = `
    ${conflictCtaHtml(s)}
    ${reviewReady ? `
      <div class="pr-review-cta">
        <span class="pr-review-cta-label">${s.state === 'implementing' ? 'Uncommitted changes on this branch' : 'Review the branch diff'}</span>
        <div class="pr-review-cta-actions">
          <button type="button" class="o-btn o-btn--default pr-discard-btn" data-pr-action="discard">Discard</button>
          <button type="button" class="o-btn o-btn--primary" data-diff-action="review">Review changes →</button>
        </div>
      </div>
    ` : ''}

    ${openThreads.length === 0 ? '' : `
      <div class="threads">
        ${openThreads.map((chain) => renderThreadCard(chain, draftFor(chain), s)).join('')}
      </div>
    `}
    ${docDisclosureHtml('Spec', 'pr-spec', spec)}
    ${docDisclosureHtml('Implementation plan', 'pr-implplan', implPlan)}
    ${renderChecksHtml(s, prClosed)}
    ${resolvedThreads.length ? `
      <details class="pr-disclosure pr-threads-resolved">
        ${disclosureSummary('Comments', `${resolvedThreads.length} resolved`)}
        <div class="threads">
          ${resolvedThreads.map((chain) => renderThreadCard(chain, undefined, s)).join('')}
        </div>
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

export function wirePrBlockActions(el, job, s) {
  el.querySelector('[data-diff-action="review"]')?.addEventListener('click', () => {
    void openDiffForStep({ jobId: job.id, stepId: s.id, sessionId: s.sessionId });
  });
  el.querySelector('[data-pr-action="resolve-conflicts"]')?.addEventListener('click', () => {
    void work.approve(job.id, { gate: 'resolve-conflicts', stepId: s.id });
  });
  el.querySelector('[data-pr-action="reject-conflicts"]')?.addEventListener('click', () => {
    void work.reject(job.id, { gate: 'resolve-conflicts', stepId: s.id });
  });
  el.querySelector('[data-pr-action="discard"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const branch = s.workspace?.branch ?? 'this branch';
    if (!confirm(`Discard ALL uncommitted changes on ${branch}? Staged and unstaged edits are reverted and untracked files removed. This cannot be undone.`)) return;
    btn.disabled = true;
    try {
      await discardAll(s.sessionId);
    } catch (err) {
      alert(`Discard failed: ${err?.message ?? err}`);
    } finally {
      btn.disabled = false;
    }
  });
  el.querySelectorAll('.thread').forEach((threadEl) => wireThreadCard(threadEl, job, s));
}
