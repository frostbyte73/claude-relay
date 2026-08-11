// Shared subagent "card" renderer — a compact live/done preview (type badge,
// goal, fading last-N-lines, Expand link). Used by the Sessions right rail
// (sessions-surface/rail.js). Adapted from the former session-view docked-feed
// strip, which was removed once the desktop rail went persistent and mobile
// moved to the Agents entry strip + agents sheet.
//
// agents-sheet/index.js's own per-agent view is a full mini-transcript (tabs +
// tool tiles + approval cards), a different shape from this compact card, so it
// isn't rebuilt on top of this module — but shares the same type→tone mapping.

import { escapeHtml } from '../../util.js';
import { sessions } from '../../state/sessions.js';
import { oneLineMsgHtml } from '../session-view/message-html.js';
import { TOOL_VERBS, fmtStripDuration, thinkingStripHtml } from '../session-view/regions.js';
import { relPast } from '../../utils/formatting.js';

const REVIEW_HINTS = ['review', 'critic'];
const READ_HINTS = ['explore', 'read', 'research', 'investigate', 'general-purpose', 'general'];

// Three-way color coding per the design spec: read-shape agents (explore/
// research/general) in blue, review-shape agents in yellow, everything else
// (code-writing agents, etc.) in neutral gray.
export function subagentTone(agentType) {
  const t = (agentType || '').toLowerCase();
  if (REVIEW_HINTS.some((h) => t.includes(h))) return 'review';
  if (READ_HINTS.some((h) => t.includes(h))) return 'explore';
  return 'general';
}

// Header status is only shown once the agent is done — while it's live, the
// thinking strip at the bottom of the card already carries the verb + timer, so
// a second verb/timer/pulse in the top-right would just duplicate it. Once done,
// show a coarse "finished 3m ago" (via relPast) rather than a live-counting run
// duration — the card is rebuilt on every subagent tick, and a seconds timer
// off firstSeenAt would keep ticking up long after the agent completed.
function statusText(bucket) {
  const isKilled = bucket.completion.status === 'killed';
  const verb = isKilled ? 'stopped' : 'finished';
  const ago = relPast(bucket.completion.completedAt);
  return ago ? `${verb} ${ago}` : verb;
}

// Last N one-line summaries of resolved (non-pending) tool activity, oldest
// first — the "fading last-N-lines" live preview from the mockup. Pending
// approvals are intentionally excluded; those render as full cards in the main
// feed / agents sheet where the user can act on them.
function liveTailHtml(bucket, maxLines) {
  // Resolve path context from the bucket's own sessionId — this card can be
  // rendered for any bucket in the rail/agents-sheet regardless of which
  // session happens to be open elsewhere in the app.
  const slice = bucket.sessionId ? sessions.getSlice(bucket.sessionId) : null;
  const ctx = { cwd: slice?.cwd ?? null, worktreePath: slice?.spawnCwd ?? null };
  const resolved = bucket.entries.filter((e) => e.decision !== null && e.toolName);
  const lines = [];
  for (let i = resolved.length - 1; i >= 0 && lines.length < maxLines; i -= 1) {
    const html = oneLineMsgHtml({
      role: 'tool_use',
      toolName: resolved[i].toolName,
      toolInput: resolved[i].toolInput,
    }, ctx);
    if (html) lines.unshift(html);
  }
  if (lines.length === 0) {
    return bucket.completion?.summary
      ? `<div class="inline-line" data-role="assistant"><span class="inline-line-body">${escapeHtml(bucket.completion.summary)}</span></div>`
      : `<div class="inline-line" data-role="assistant"><span class="inline-line-body">starting…</span></div>`;
  }
  return lines.join('');
}

// Compact card for one subagent bucket. `agentId` drives the click target
// (data-attr, wired by the caller) so this module stays DOM-event-free.
export function subagentCardHtml(agentId, bucket, { maxLines = 6 } = {}) {
  const tone = subagentTone(bucket.agentType);
  const label = bucket.agentType || 'agent';
  const isDone = !!bucket.completion;
  const goal = bucket.description || '';
  // A resumed agent times its current run from the wake, not from the original
  // spawn — otherwise the strip reports the hours it spent finished.
  const lastTool = [...bucket.entries].reverse().find((e) => e.toolName);
  const thinking = !isDone ? `<div class="rail-subagent-thinking">${thinkingStripHtml(
    (lastTool && TOOL_VERBS[lastTool.toolName]) || 'thinking',
    fmtStripDuration(bucket.resumedAt || bucket.firstSeenAt),
  )}</div>` : '';
  return (
    `<div class="rail-subagent${isDone ? ' is-done' : ''}" data-agent-id="${escapeHtml(agentId)}" role="button" tabindex="0"` +
      ` aria-label="Expand ${escapeHtml(label)}">` +
      `<div class="rail-subagent-hdr">` +
        `<span class="rail-subagent-type rail-subagent-type-${tone}">${escapeHtml(label)}</span>` +
        (isDone
          ? `<span class="rail-subagent-status">${escapeHtml(statusText(bucket))}</span>`
          : `<span class="rail-subagent-expand">Expand ↗</span>`) +
      `</div>` +
      (goal ? `<div class="rail-subagent-goal">${escapeHtml(goal)}</div>` : '') +
      `<div class="rail-subagent-live">${liveTailHtml(bucket, maxLines)}</div>` +
      thinking +
    `</div>`
  );
}
