import { linearQuery as defaultQuery } from './linear-api.js';
import type { JobRecord, OrchestratedStep } from '../work/work-types.js';

type QueryFn = typeof defaultQuery;

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearWriterOpts {
  query?: QueryFn;
  // Optional per-installation override, keyed by logical state. Left unset for
  // multi-team setups where a single UUID can't be right — see resolveStateId.
  stateIds?: Partial<{ inProgress: string; inReview: string; done: string }>;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];

// Pick the workflow state that best matches a logical Outpost state. Linear state
// UUIDs are per-team, so we match on `type` (stable across teams) and use a name
// preference to disambiguate the two `started` states most teams carry ("In
// Progress" vs "In Review"). Returns null when the team has no matching column —
// e.g. no review stage — which callers treat as a benign no-op.
export function resolveStateId(
  states: WorkflowState[],
  logical: 'inProgress' | 'inReview' | 'done',
): string | null {
  const byType = (t: string) => states.filter((s) => s.type === t);
  const prefer = (cands: WorkflowState[], re: RegExp) => cands.find((s) => re.test(s.name)) ?? null;

  if (logical === 'done') {
    const completed = byType('completed');
    return (prefer(completed, /done/i) ?? completed[0])?.id ?? null;
  }

  const started = byType('started');
  const review = prefer(started, /review/i);
  if (logical === 'inReview') return review?.id ?? null;
  // inProgress: prefer a "progress"-named state, else any started column that
  // isn't the review one, so we don't accidentally park the ticket in review.
  const progress = prefer(started, /progress/i) ?? started.find((s) => s.id !== review?.id) ?? started[0];
  return progress?.id ?? null;
}

function shortRepoName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : (parts[0] ?? cwd);
}

function prStepLine(s: OrchestratedStep): string {
  const ws = s.workspace;
  const name = ws.kind === 'none' ? s.title : shortRepoName(ws.repoCwd);
  const pr = s.pr;
  if (!pr?.prUrl) return `- ${name} — (no PR yet)`;
  const stateBits: string[] = [];
  if (pr.prState === 'merged') stateBits.push('merged');
  else if (pr.prState === 'closed') stateBits.push('closed');
  else stateBits.push('open');
  if (pr.reviewState === 'changes_requested' && pr.comments?.length) {
    stateBits.push(`${pr.comments.length} comment${pr.comments.length === 1 ? '' : 's'}`);
  }
  if (pr.ciState === 'success') stateBits.push('CI ✅');
  else if (pr.ciState === 'failure') stateBits.push('CI ❌');
  else if (pr.ciState === 'pending') stateBits.push('CI ⏳');
  return `- ${name} — PR ${pr.prUrl} (${stateBits.join(', ')})`;
}

export function formatStatusBody(j: JobRecord): string {
  const lines = ['Outpost status:'];
  const prSteps = j.steps.filter((s): s is OrchestratedStep => s.type === 'orchestrated' && !s.cancelled);
  for (const s of prSteps) lines.push(prStepLine(s));
  return lines.join('\n');
}

export class LinearWriter {
  private readonly query: QueryFn;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly opts: LinearWriterOpts) {
    this.query = opts.query ?? defaultQuery;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async setState(linearUuid: string, state: 'inProgress' | 'inReview' | 'done'): Promise<void> {
    // An explicit override wins; otherwise resolve against the issue's own team so
    // the mapping is correct regardless of which team the ticket lives in.
    let stateId = this.opts.stateIds?.[state] ?? '';
    if (!stateId) {
      const states = await this.fetchTeamStates(linearUuid);
      stateId = resolveStateId(states, state) ?? '';
    }
    // No matching column (e.g. a team with no review stage) → nothing to do. This
    // is a permanent no-op, not a failure, so we return rather than throwing and
    // stalling the orchestrator's per-tick retry.
    if (!stateId) return;
    await this.withRetry(async () => {
      await this.query<{ issueUpdate: { success: boolean } }>(
        `mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: linearUuid, input: { stateId } },
      );
    });
  }

  private async fetchTeamStates(linearUuid: string): Promise<WorkflowState[]> {
    const data = await this.query<{ issue: { team: { states: { nodes: WorkflowState[] } } } }>(
      `query ($id: String!) { issue(id: $id) { team { states { nodes { id name type } } } } }`,
      { id: linearUuid },
    );
    return data.issue.team.states.nodes;
  }

  async upsertStatusComment(j: JobRecord): Promise<string> {
    const linearUuid = j.externalRef?.linearUuid;
    if (!linearUuid) throw new Error('upsertStatusComment: job has no linear externalRef');
    const body = formatStatusBody(j);
    return await this.withRetry(async () => {
      if (j.linearCommentId) {
        const data = await this.query<{ commentUpdate: { comment: { id: string } } }>(
          `mutation ($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { comment { id } } }`,
          { id: j.linearCommentId, input: { body } },
        );
        return data.commentUpdate.comment.id;
      }
      const data = await this.query<{ commentCreate: { comment: { id: string } } }>(
        `mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
        { input: { issueId: linearUuid, body } },
      );
      return data.commentCreate.comment.id;
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (i === RETRY_DELAYS_MS.length) break;
        await this.sleep(RETRY_DELAYS_MS[i]!);
      }
    }
    throw lastErr;
  }
}
