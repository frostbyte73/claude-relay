import type { ActionRunOutcome } from '../storage/action-runs-store.js';
import type { ActionEdit, ActionProposal } from '../storage/action-edits-store.js';

// The branching a posted action-proposal goes through, lifted out of routes/actions.ts's
// factory closure so it's reachable from a test without standing up a Server — the same
// extraction revertToEvent/buildRevisionHistory got.
//
// Two posters share this path: meta.build-action (a user asked for an edit) and
// meta.improve-actions (a schedule found evidence worth acting on). The second can also
// conclude nothing is worth changing, which is a real outcome rather than a no-op.

const RULE_KINDS = ['tool', 'bash', 'mcp', 'path'] as const;
const MAX_EVIDENCE = 10;
const MAX_EVIDENCE_LEN = 300;

export interface ProposalPayload {
  sessionId?: string;
  actionName?: string | null;
  summary?: string;
  skillMdAfter?: string;
  noChange?: boolean;
  evidence?: unknown;
  allowlistAdds?: Array<{ kind: string; value: string }>;
}

export type ProposalIntake =
  | { kind: 'proposal'; proposal: ActionProposal }
  | { kind: 'no-change'; summary: string }
  | { kind: 'invalid'; reason: string };

function normalizeEvidence(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().slice(0, MAX_EVIDENCE_LEN))
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE);
}

function normalizeRules(raw: ProposalPayload['allowlistAdds']): ActionProposal['allowlistAdds'] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is ActionProposal['allowlistAdds'][number] =>
    !!r && typeof r.value === 'string' && (RULE_KINDS as readonly string[]).includes(r.kind));
}

export function netLineDelta(before: string, after: string): number {
  const lines = (s: string) => (s === '' ? 0 : s.replace(/\n$/, '').split('\n').length);
  return lines(after) - lines(before);
}

export function intakeProposal(
  payload: ProposalPayload,
  ctx: { skillMdBefore: string; now: number },
): ProposalIntake {
  // The flag wins over a body sent alongside it: "nothing to change" must never be able
  // to apply a write by accident.
  if (payload.noChange === true) return { kind: 'no-change', summary: payload.summary ?? '' };
  if (typeof payload.skillMdAfter !== 'string') {
    return { kind: 'invalid', reason: 'expected either skillMdAfter or noChange:true' };
  }
  return {
    kind: 'proposal',
    proposal: {
      summary: payload.summary ?? '',
      skillMdBefore: ctx.skillMdBefore,
      skillMdAfter: payload.skillMdAfter,
      allowlistAdds: normalizeRules(payload.allowlistAdds),
      postedAt: ctx.now,
      evidence: normalizeEvidence(payload.evidence),
      netLineDelta: netLineDelta(ctx.skillMdBefore, payload.skillMdAfter),
    },
  };
}

// A posted proposal outlives the session that posted it. An improver posts and stops
// talking, so its process is idle-reaped long before the user gets to the review card —
// discarding the draft there would mean a token-opportunistic improver never delivers
// anything. Approve tolerates a dead session and proposal-feedback resumes one, so
// keeping the edit costs nothing. An edit with no proposal is genuinely abandoned.
export function onSessionGone(edit: ActionEdit): { keep: boolean; outcome: ActionRunOutcome } {
  return edit.proposal
    ? { keep: true, outcome: 'submitted' }
    : { keep: false, outcome: 'abandoned' };
}

export function ledgerActionFor(edit: ActionEdit): string {
  return edit.authorAction ?? 'meta.build-action';
}
