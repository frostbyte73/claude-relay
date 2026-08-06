import type { IncomingMessage, ServerResponse } from 'node:http';

// Every request body the daemon serves comes through readBody, so an uncapped one is a
// whole-process memory hazard from a single request. Sized for the largest thing the PWA
// legitimately posts (a plan, a SKILL.md revision, a long commit message) with headroom.
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body too large (limit ${limit} bytes)`);
    this.name = 'BodyTooLargeError';
  }
}

// Concatenate first, decode once: a chunk boundary lands wherever the socket puts it, and
// decoding each Buffer on its own turns any multi-byte character straddling one into U+FFFD.
export function readBody(req: NodeJS.ReadableStream, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    // A real IncomingMessage emits Buffers; a stream someone called setEncoding on (or a
    // Readable.from over strings) emits strings, already decoded and safe to take as-is.
    req.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const c = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += c.length;
      if (size > limit) {
        done = true;
        (req as { destroy?: (e?: Error) => void }).destroy?.();
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
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

// No `res` to answer 413 on, so an oversized body reads as "no usable payload" — the null
// its callers already handle. readJsonObject is the variant that can say why.
export async function readJsonBody<T>(req: NodeJS.ReadableStream, limit = MAX_BODY_BYTES): Promise<T | null> {
  try {
    return parseJsonObject(await readBody(req, limit)) as T | null;
  } catch {
    return null;
  }
}

export interface JsonObjectOpts {
  // Routes that spell `body ? JSON.parse(body) : {}` accept a MISSING body. Deliberately not
  // `!raw.trim()`: a whitespace-only body is truthy, so it used to reach JSON.parse and 400.
  // Widening it to "empty" would let `POST .../git/discard` with a body of " " fall through to
  // paths=undefined, i.e. `git reset --hard` + `git clean -fd` on a request that used to bounce.
  allowEmpty?: boolean;
  // Routes whose 400 carries a JSON error body rather than the plain-text default.
  onInvalid?: () => void;
  // Override for a route that legitimately accepts more (or should accept less) than the default.
  limit?: number;
}

export async function readJsonObject<T>(
  req: IncomingMessage,
  res: ServerResponse,
  opts: JsonObjectOpts = {},
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readBody(req, opts.limit ?? MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      res.statusCode = 413;
      res.end('payload too large');
      return null;
    }
    throw e;
  }
  if (!raw && opts.allowEmpty) return {} as T;
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
