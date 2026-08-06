import type { IncomingMessage, ServerResponse } from 'node:http';

export function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// `JSON.parse("null")` succeeds, so a bare `try/catch` around it is not a shape check.
export function parseJsonObject(body: string): Record<string, unknown> | null {
  if (!body.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  return isPlainObject(parsed) ? parsed : null;
}

export async function readJsonBody<T>(req: NodeJS.ReadableStream): Promise<T | null> {
  return parseJsonObject(await readBody(req)) as T | null;
}

export interface JsonObjectOpts {
  // Routes that today spell `body ? JSON.parse(body) : {}` accept a missing body.
  allowEmpty?: boolean;
  // Routes whose 400 carries a JSON error body rather than the plain-text default.
  onInvalid?: () => void;
}

export async function readJsonObject<T>(
  req: IncomingMessage,
  res: ServerResponse,
  opts: JsonObjectOpts = {},
): Promise<T | null> {
  const raw = await readBody(req);
  if (!raw.trim() && opts.allowEmpty) return {} as T;
  const parsed = parseJsonObject(raw);
  if (parsed) return parsed as T;
  if (opts.onInvalid) opts.onInvalid();
  else { res.statusCode = 400; res.end('invalid json'); }
  return null;
}

// "24h", "7d", "90m", or a bare millisecond count. Anything else (including
// "all"/missing) means no cutoff.
export function parseWindowMs(raw: string | null): number | undefined {
  if (!raw || raw === 'all') return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(\d+)(m|h|d)$/);
  if (!m) return undefined;
  const unitMs = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  return Number(m[1]) * unitMs;
}
