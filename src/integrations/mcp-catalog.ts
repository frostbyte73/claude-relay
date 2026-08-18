import { transportOf, type McpServerConfig } from './mcp-config.js';

// Tool names here are the server's LOCAL names (e.g. `get_issue`), not the
// `mcp__<server>__<tool>` form the permission system and tool-classify.ts use. Whoever
// consumes this catalog to propose group placements has to build that prefixed name itself.
export interface McpTool {
  name: string;
  description?: string;
}

export type CatalogResult =
  | { server: string; status: 'ok'; tools: McpTool[] }
  | { server: string; status: 'unreachable' | 'unauthorized' | 'unsupported' | 'timeout'; reason: string };

const MCP_PROBE_TIMEOUT_MS = 2500;
const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// Streamable-HTTP servers may answer with an SSE-framed body (`event: message\ndata: {...}`)
// instead of a bare JSON body; pull the JSON-RPC payload out of the last `data:` line. A body
// that's neither shape (HTML, empty, garbage) yields null, which callers treat as unsupported.
function parseJsonRpcBody(raw: string, contentType: string | null): JsonRpcResponse | null {
  const text = raw.trim();
  if (!text) return null;
  if ((contentType ?? '').includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
    const lastLine = dataLines.at(-1);
    if (lastLine === undefined) return null;
    const last = lastLine.slice('data:'.length).trim();
    try {
      return JSON.parse(last) as JsonRpcResponse;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    return null;
  }
}

interface RpcCallResult {
  httpStatus: number;
  sessionId?: string;
  parsed: JsonRpcResponse | null;
}

async function rpcCall(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<RpcCallResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  const sessionId = res.headers.get('mcp-session-id') ?? undefined;
  const raw = await res.text();
  const parsed = parseJsonRpcBody(raw, res.headers.get('content-type'));
  return { httpStatus: res.status, sessionId, parsed };
}

function isToolLike(v: unknown): v is { name: string; description?: unknown } {
  return !!v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string';
}

export async function listTools(
  server: string,
  cfg: McpServerConfig,
  opts?: { timeoutMs?: number },
): Promise<CatalogResult> {
  const transport = transportOf(cfg);
  if (transport === 'stdio') {
    // Enumerating a stdio server means spawning the configured binary — arbitrary command
    // execution driven by a config file. That's its own task with its own review, not a
    // step buried inside an HTTP discovery request. Deliberately not spawning anything here.
    return { server, status: 'unsupported', reason: 'stdio transport — enumeration requires spawning the server' };
  }
  if (!cfg.url) {
    return { server, status: 'unreachable', reason: 'no url configured' };
  }
  const url = cfg.url;

  const timeoutMs = opts?.timeoutMs ?? MCP_PROBE_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const baseHeaders = { ...(cfg.headers ?? {}) };

    const init = await rpcCall(url, baseHeaders, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'outpost', version: '0.1.0' },
      },
    }, ac.signal);

    if (init.httpStatus === 401 || init.httpStatus === 403) {
      return { server, status: 'unauthorized', reason: `initialize returned HTTP ${init.httpStatus}` };
    }
    if (!init.parsed || init.parsed.error) {
      return {
        server,
        status: 'unsupported',
        reason: init.parsed?.error?.message ?? `initialize did not return a JSON-RPC result (HTTP ${init.httpStatus})`,
      };
    }

    // A missing Mcp-Session-Id means this server doesn't need one, not an error —
    // some MCP servers are stateless and answer tools/list cold.
    const sessionHeaders = init.sessionId ? { ...baseHeaders, 'mcp-session-id': init.sessionId } : baseHeaders;

    await rpcCall(url, sessionHeaders, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, ac.signal);

    const list = await rpcCall(url, sessionHeaders, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }, ac.signal);

    if (list.httpStatus === 401 || list.httpStatus === 403) {
      return { server, status: 'unauthorized', reason: `tools/list returned HTTP ${list.httpStatus}` };
    }
    if (!list.parsed || list.parsed.error) {
      return {
        server,
        status: 'unsupported',
        reason: list.parsed?.error?.message ?? `tools/list did not return a JSON-RPC result (HTTP ${list.httpStatus})`,
      };
    }
    const result = list.parsed.result as { tools?: unknown } | undefined;
    if (!result || !Array.isArray(result.tools)) {
      return { server, status: 'unsupported', reason: 'tools/list result missing a tools array' };
    }

    const tools: McpTool[] = result.tools.filter(isToolLike).map((t) => (
      typeof t.description === 'string' ? { name: t.name, description: t.description } : { name: t.name }
    ));
    return { server, status: 'ok', tools };
  } catch (e) {
    if (ac.signal.aborted) {
      return { server, status: 'timeout', reason: `no response within ${timeoutMs}ms` };
    }
    return { server, status: 'unreachable', reason: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
