// MCP (Model Context Protocol) surface for the daemon-side "submit-your-output"
// endpoints that Outpost actions used to hit via bash+curl+jq. Speaks Streamable
// HTTP transport: one POST /mcp per JSON-RPC message (or batch), synchronous JSON
// response. No SSE — every tool here is a short synchronous write to daemon state.

import { isPlainObject } from './routes/util.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface McpDispatch {
  [name: string]: (args: Record<string, unknown>) => Promise<unknown>;
}

// A JSON-RPC 2.0 message from the client. Requests have an id; notifications don't.
type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

const PROTOCOL_VERSION = '2024-11-05';

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function handleMcpRequest(rawBody: string, tools: McpTool[], dispatch: McpDispatch): Promise<McpResponse> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); }
  catch { return jsonResponse(400, jsonRpcError(null, -32700, 'parse error')); }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  // `handleOne` reads `msg.id`/`msg.method` — a literal `null`/array/primitive element
  // (top-level or inside a batch) would throw there instead of degrading gracefully.
  // Reject the whole batch with the same shape a parse failure already returns.
  if (candidates.some((m) => !isPlainObject(m))) {
    return jsonResponse(400, jsonRpcError(null, -32700, 'parse error'));
  }
  const messages = candidates as JsonRpcMessage[];
  const responses: unknown[] = [];
  for (const msg of messages) {
    const reply = await handleOne(msg, tools, dispatch);
    if (reply !== undefined) responses.push(reply);
  }
  if (responses.length === 0) return { status: 202, headers: {}, body: '' };
  const body = Array.isArray(parsed) ? JSON.stringify(responses) : JSON.stringify(responses[0]);
  return { status: 200, headers: { 'content-type': 'application/json' }, body };
}

async function handleOne(msg: JsonRpcMessage, tools: McpTool[], dispatch: McpDispatch): Promise<unknown> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;
  const method = msg.method;

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'outpost', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return undefined;
  }
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools });
  }
  if (method === 'tools/call') {
    const params = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (!name || !dispatch[name]) return jsonRpcError(id, -32601, `unknown tool: ${name}`);
    try {
      const result = await dispatch[name](args);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
      });
    } catch (e) {
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: (e as Error).message }],
      });
    }
  }
  if (isNotification) return undefined;
  return jsonRpcError(id, -32601, `unknown method: ${method}`);
}

function jsonRpcResult(id: number | string | null, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: number | string | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonResponse(status: number, body: unknown): McpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const OUTPOST_MCP_TOOLS: McpTool[] = [
  {
    name: 'submit_plan',
    description: 'Post the orchestrator\'s ordered, typed plan to the daemon. Call once per orchestrator run, right after printing the preview. `steps` follows the shape in the stepTypeCatalog / actionCatalog fields of your envelope. In `mode: "replan"`, every non-cancelled step in `currentSteps` must have a disposition — either a proposed step with matching `keepId` or an entry in `drops`. Omission is rejected. Pass `findings` when you investigated up front so the user sees your evidence at approval.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'mode', 'steps'],
      properties: {
        jobId: { type: 'string' },
        mode: { type: 'string', enum: ['initial', 'replan'] },
        steps: { type: 'array', items: { type: 'object' } },
        drops: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replan-only: ids of currentSteps to remove from the plan. Every non-cancelled currentStep must be either kept (via a proposed step\'s keepId) or dropped here.',
        },
        feedback: { type: 'string', description: 'Optional prose feedback shown to the user alongside the plan.' },
        findings: {
          type: 'object',
          description: 'Optional structured investigation the orchestrator ran up front — markdown writeup + evidence + optional verdict + caveats. Same shape as read.investigate output. Shown to the user at plan approval and persisted for audit. Omit for trivially-routable jobs, but record at least a one-line verification when there was a claim to check.',
          required: ['findings'],
          properties: {
            findings: { type: 'string', description: 'Primary markdown writeup. Specific, cited, calibrated.' },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                required: ['kind', 'summary'],
                additionalProperties: false,
                properties: {
                  kind: { type: 'string' },
                  source: { type: 'string' },
                  summary: { type: 'string' },
                  excerpt: { type: 'string' },
                },
              },
            },
            verdict: {
              type: 'object',
              required: ['kind', 'confidence'],
              properties: {
                kind: { type: 'string', enum: ['service-bug', 'outage', 'client-side', 'external', 'unknown'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                responsible_team: { type: 'string' },
                suggested_title: { type: 'string' },
                writeup: { type: 'string' },
                customer_summary: { type: 'string' },
              },
            },
            caveats: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  {
    name: 'submit_continue',
    description: 'Step-review only: signal that the plan still holds after the just-completed step. The engine advances to the next step, or marks the job done if none remain. Use instead of submit_plan when nothing needs to change.',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: {
        jobId: { type: 'string' },
        reason: { type: 'string', description: 'Optional one-liner for the timeline, e.g. "findings confirm the plan".' },
      },
    },
  },
  {
    name: 'submit_journal',
    description: 'Append one short lesson (≤300 chars) the next run of this action should know. Skip when there is nothing new.',
    inputSchema: {
      type: 'object',
      required: ['action', 'jobId', 'outcome', 'lesson'],
      properties: {
        action: { type: 'string', description: 'Action name, e.g. `meta.orchestrate`.' },
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        outcome: { type: 'string', description: 'One of: posted, abandoned, blocked, edited (or action-specific).' },
        lesson: { type: 'string', maxLength: 300 },
      },
    },
  },
  {
    name: 'submit_step_output',
    description: 'Post a completed step\'s structured output back to the orchestrator. `output` is a JSON-encoded string (the orchestrator forwards it as `output` on the step and, when `forwardOutput` is true, appends it to downstream envelopes).',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        output: { type: 'string' },
      },
    },
  },
  {
    name: 'submit_write_draft',
    description:
      'Submit the exact payload of an external write for the user\'s approval, and DO NOT perform '
      + 'the write. `calls` is the ordered list of calls you will make once approved — each is either '
      + '`{bash}` (the literal command text) or `{tool: {name, args}}` (an MCP tool and its arguments '
      + 'verbatim). The user sees every field and may edit any of them. If a `bash` call references a '
      + 'file via --input/--body-file/--notes-file, draft its body inline as `files: {"<path>": '
      + '"<content>"}` instead of writing the file yourself — the user edits the body directly in the '
      + 'approval card, and the daemon writes your approved (possibly user-edited) content to that '
      + 'exact path itself at accept time, then pins the write to that content\'s digest. Every `files` '
      + 'key must be a path the same call\'s `bash` actually references and must be under /tmp/, or the '
      + 'whole draft is refused. `evidence` is read-only context for their decision (a staged diff, a '
      + 'rendered preview); `summary` is one line naming what will happen. Parks this unit for '
      + 'approval. The user accepts (→ you resume with writeGate.phase === "commit" and approvedCalls, '
      + 'which you must run VERBATIM — the hook denies anything else), proposes changes (→ you resume '
      + 'in the draft phase with their feedback), or denies (→ the write never happens). Call this '
      + 'instead of writing; a gated write attempted without an approved pin is denied.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'summary', 'calls'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        dispatchId: { type: 'string', description: 'Set only if you are a dispatched child.' },
        summary: { type: 'string', description: 'One line naming what will happen.' },
        evidence: { type: 'string', description: 'Read-only markdown context for the decision.' },
        calls: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              bash: { type: 'string', description: 'Literal command text, exactly as it will run.' },
              tool: {
                type: 'object',
                required: ['name', 'args'],
                properties: { name: { type: 'string' }, args: { type: 'object' } },
              },
              files: {
                type: 'object',
                description:
                  'Only for a `bash` call: path -> file body, for each --input/--body-file/'
                  + '--notes-file path this call references whose content you want editable inline '
                  + 'in the approval card. Every key must be one of this call\'s own referenced '
                  + 'paths and must be under /tmp/.',
                additionalProperties: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'submit_step_failed',
    description: 'Report that this step could not be completed and why. Terminal — the orchestrator will not retry.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'reason'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'submit_step_progress',
    description:
      'Report this orchestrated step\'s progress and declare your next move. Call exactly once at the '
      + 'end of every turn. `memo` is your durable narrative — rewrite it each turn with what a future '
      + 'you (after a compaction or a cold resume) would need to know; it is replayed in your envelope. '
      + '`artifacts` are named markdown blobs merged into the step (spec, implPlan, review, ...). '
      + '`next` is one of: {kind:"self-round",action?,note?} continue on your own session, optionally '
      + 'rebound to another action\'s skill and permissions; {kind:"dispatch",dispatches:[{action,brief}]} '
      + 'fan out to fresh sessions, each seeing only its brief; {kind:"wait",wait:{reason,events?,'
      + 'untilAllDispatchesDone?}} park until the daemon wakes you (you cannot arm a timer of your '
      + 'own — name the events you are waiting for); {kind:"gate",draft,question} '
      + 'ask the user to approve; {kind:"resolve",output} finish; {kind:"fail",reason} give up. '
      + 'External writes are gated by the daemon whether or not you ask.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'next'],
      additionalProperties: false,
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        memo: { type: 'string', description: 'Your durable narrative. Rewritten each turn; replayed in your envelope.' },
        phase: { type: 'string', description: 'Short label for where the step is, e.g. spec, implement, pr_open.' },
        artifacts: {
          type: 'object',
          description: 'Named markdown blobs merged into the step (spec, implPlan, review, ...).',
          additionalProperties: { type: 'string' },
        },
        next: {
          description: 'Exactly one move.',
          oneOf: [
            {
              type: 'object', required: ['kind'], additionalProperties: false,
              properties: {
                kind: { const: 'self-round' },
                action: { type: 'string', description: "Catalog action whose skill and permissions to wear this turn." },
                note: { type: 'string' },
              },
            },
            {
              type: 'object', required: ['kind', 'dispatches'], additionalProperties: false,
              properties: {
                kind: { const: 'dispatch' },
                dispatches: {
                  type: 'array', minItems: 1,
                  items: {
                    type: 'object', required: ['action', 'brief'], additionalProperties: false,
                    properties: {
                      action: { type: 'string' },
                      brief: { type: 'string', description: 'All the context this child gets. It sees nothing else.' },
                      inputs: { type: 'object' },
                      workspace: { type: 'object' },
                      retryOf: {
                        type: 'string',
                        description:
                          'Only when re-running a dispatch that FAILED for a transient reason — an MCP server '
                          + 'that was not authenticated, a network blip, an infra hiccup. Set it to that '
                          + "dispatch's id. Required to repeat an identical (action, brief); without it a "
                          + 'duplicate is rejected. If the child failed because it misunderstood the brief, '
                          + 'do not retry — write a better brief. Each dispatch gets a hard cap of retries; '
                          + 'once reached, further retries of it are refused — do the work yourself in a '
                          + 'self-round, or fail the step.',
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'object', required: ['kind', 'wait'], additionalProperties: false,
              properties: {
                kind: { const: 'wait' },
                wait: {
                  type: 'object', required: ['reason'], additionalProperties: false,
                  properties: {
                    reason: { type: 'string', description: 'Shown to the user while parked.' },
                    events: {
                      type: 'array',
                      items: { enum: ['pr-comments', 'ci', 'review-state', 'pr-state', 'head-moved', 'dispatches'] },
                    },
                    untilAllDispatchesDone: { type: 'boolean' },
                  },
                },
              },
            },
            {
              type: 'object', required: ['kind', 'draft', 'question'], additionalProperties: false,
              properties: {
                kind: { const: 'gate' },
                draft: { type: 'string', description: 'Markdown the user is approving.' },
                question: { type: 'string' },
              },
            },
            {
              type: 'object', required: ['kind', 'output'], additionalProperties: false,
              properties: { kind: { const: 'resolve' }, output: { type: 'string' } },
            },
            {
              type: 'object', required: ['kind', 'reason'], additionalProperties: false,
              properties: { kind: { const: 'fail' }, reason: { type: 'string' } },
            },
          ],
        },
      },
    },
  },
  {
    name: 'submit_action_proposal',
    description: 'Deliver an action proposal (new or revised SKILL.md + optional allowlist additions) to the daemon — posted by meta.build-action and meta.improve-actions alike. The user reviews it inline in the PWA. `skillMdAfter` is required unless `noChange` is true.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        actionName: { type: 'string' },
        summary: { type: 'string' },
        skillMdAfter: { type: 'string' },
        noChange: {
          type: 'boolean',
          description: 'Set true to record that the action was reviewed and nothing was worth changing. Omit skillMdAfter. Produces a history entry, not a review card.',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short cited observations backing this proposal (which runs, which failures). Shown on the review card so the user sees why, not just a diff.',
        },
        allowlistAdds: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'value'],
            properties: {
              kind: { type: 'string', enum: ['tool', 'bash', 'mcp', 'path'] },
              value: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'submit_schedule_proposal',
    description: 'Deliver a meta.build-schedule draft (name + trigger + what) to the daemon. It lands in the schedule editor for the user to test and save.',
    inputSchema: {
      type: 'object',
      required: ['scheduleEditSessionId', 'name', 'trigger', 'what'],
      properties: {
        scheduleEditSessionId: { type: 'string' },
        name: { type: 'string' },
        summary: { type: 'string' },
        trigger: { type: 'object' },
        what: { type: 'object' },
      },
    },
  },
  {
    name: 'create_job',
    description: 'Enqueue an Outpost job from a skill or script. Idempotent on dedupeKey — a key that already maps to a job returns that job instead of creating a duplicate. Use for job-source polling (e.g. one job per open ticket).',
    inputSchema: {
      type: 'object',
      required: ['source', 'title'],
      properties: {
        source: { type: 'string', description: 'Job source id, e.g. "linear" or your own source name.' },
        title: { type: 'string' },
        body: { type: 'string' },
        dedupeKey: { type: 'string', description: 'Idempotency key. Same key never enqueues twice.' },
        externalRef: {
          type: 'object',
          properties: { url: { type: 'string' }, issueIdentifier: { type: 'string' }, linearUuid: { type: 'string' } },
        },
      },
    },
  },
];
