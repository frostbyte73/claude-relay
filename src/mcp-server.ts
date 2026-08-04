// MCP (Model Context Protocol) surface for the daemon-side "submit-your-output"
// endpoints that Outpost actions used to hit via bash+curl+jq. Speaks Streamable
// HTTP transport: one POST /mcp per JSON-RPC message (or batch), synchronous JSON
// response. No SSE — every tool here is a short synchronous write to daemon state.

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

  const messages = Array.isArray(parsed) ? parsed as JsonRpcMessage[] : [parsed as JsonRpcMessage];
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
    name: 'submit_spec',
    description: 'Post the design spec for this open-pr step back to Outpost. `spec` is the full design doc as markdown. Sets the step to spec_pending_review — the user reviews the rendered spec and either accepts (→ plan round) or proposes changes (resumes this session as code.spec with their feedback). Call once, at the end of the spec round, after your self-review.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'spec'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        spec: { type: 'string', description: 'Full design spec as markdown.' },
      },
    },
  },
  {
    name: 'submit_impl_plan',
    description: 'Post the implementation plan for this open-pr step back to Outpost. `plan` is the task-by-task plan as markdown. Advances the step to the implement round (no user gate). Call once, at the end of the plan round, after your self-review. NOTE: this is the step-level implementation plan — distinct from the job-level orchestrator `submit_plan`.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'plan'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        plan: { type: 'string', description: 'Task-by-task implementation plan as markdown.' },
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
    name: 'submit_replies',
    description: 'Post drafted PR-comment replies from code.triage-pr-comments back to the orchestrator. Sets the step to `reply_pending_review` and records the triage iteration.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'drafts'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        drafts: { type: 'array', items: { type: 'object' } },
        threadHash: { type: 'string' },
      },
    },
  },
  {
    name: 'submit_edit_done',
    description: 'Signal completion (or failure) of one code.fix-pr-comment edit job. `status` is `done` or `failed`; include `failure` only on failure.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'editId', 'status'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        editId: { type: 'string' },
        status: { type: 'string', enum: ['done', 'failed'] },
        failure: { type: 'string' },
      },
    },
  },
  {
    name: 'submit_conflict_resolved',
    description: 'Signal completion of one code.resolve-conflicts round. `status` is `resolved` (merged origin/main, resolved, committed, pushed) or `unresolvable` (aborted the merge — needs a human). Include `failure` only when unresolvable.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'status'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'unresolvable'] },
        failure: { type: 'string' },
      },
    },
  },
  {
    name: 'submit_ci_fixed',
    description: 'Signal completion of one code.fix-ci round. `status` is `fixed` (edited the code to fix the failing checks, committed, pushed) or `unfixable` (could not confidently fix — e.g. infra/flake or unclear cause; needs a human). Include `failure` only when unfixable.',
    inputSchema: {
      type: 'object',
      required: ['jobId', 'stepId', 'status'],
      properties: {
        jobId: { type: 'string' },
        stepId: { type: 'string' },
        status: { type: 'string', enum: ['fixed', 'unfixable'] },
        failure: { type: 'string' },
      },
    },
  },
  {
    name: 'submit_action_proposal',
    description: 'Deliver a meta.build-action proposal (new or revised SKILL.md + optional allowlist additions) to the daemon. The user reviews it inline in the PWA.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'skillMdAfter'],
      properties: {
        sessionId: { type: 'string' },
        actionName: { type: 'string' },
        summary: { type: 'string' },
        skillMdAfter: { type: 'string' },
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
