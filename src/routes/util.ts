export function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function readJsonBody<T>(req: NodeJS.ReadableStream): Promise<T | null> {
  const body = await readBody(req);
  if (!body) return null;
  try { return JSON.parse(body) as T; } catch { return null; }
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
