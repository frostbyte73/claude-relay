import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, parseJsonObject, readBody, readJsonBody, readJsonObject } from '../../src/routes/util.js';

describe('parseJsonObject', () => {
  it('accepts a plain object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('{}')).toEqual({});
  });

  // Each of these parses successfully, so a bare try/catch around JSON.parse passes it
  // through to a handler that destructures or `in`-checks it and crashes to a 500.
  it('rejects every JSON value that is not a plain object', () => {
    for (const body of ['null', '42', '"a string"', 'true', 'false', '[]', '[{"a":1}]']) {
      expect(parseJsonObject(body), body).toBeNull();
    }
  });

  it('rejects unparsable and empty bodies', () => {
    for (const body of ['', '   ', '{', 'undefined', '{"a":]']) {
      expect(parseJsonObject(body), body).toBeNull();
    }
  });
});

function reqOf(body: string) {
  return Readable.from([body]) as unknown as IncomingMessage;
}

function resSpy() {
  const res = {
    statusCode: 0,
    ended: null as string | null,
    end(s?: string) { res.ended = s ?? ''; },
  };
  return { res: res as unknown as ServerResponse & { ended: string | null } };
}

describe('readJsonObject', () => {
  it('answers 400 for a body that is not a plain object', async () => {
    const { res } = resSpy();
    expect(await readJsonObject(reqOf('null'), res)).toBeNull();
    expect(res.statusCode).toBe(400);
  });

  it('allowEmpty accepts a MISSING body but not a whitespace-only one', async () => {
    const a = resSpy();
    expect(await readJsonObject(reqOf(''), a.res, { allowEmpty: true })).toEqual({});
    expect(a.res.statusCode).toBe(0);

    // The code this replaced tested truthiness, so "   " reached JSON.parse and 400'd.
    // Treating it as empty would hand `paths: undefined` to POST .../git/discard, which
    // is `git reset --hard` + `git clean -fd` on a request that used to bounce.
    const b = resSpy();
    expect(await readJsonObject(reqOf('   '), b.res, { allowEmpty: true })).toBeNull();
    expect(b.res.statusCode).toBe(400);
  });

  it('a missing body without allowEmpty is still a 400', async () => {
    const { res } = resSpy();
    expect(await readJsonObject(reqOf(''), res)).toBeNull();
    expect(res.statusCode).toBe(400);
  });

  it('onInvalid replaces the plain-text 400 so a route can keep its JSON error body', async () => {
    const { res } = resSpy();
    let called = 0;
    expect(await readJsonObject(reqOf('['), res, { onInvalid: () => { called++; } })).toBeNull();
    expect(called).toBe(1);
    expect(res.statusCode).toBe(0);
    expect(res.ended).toBeNull();
  });
});

// F8b: readBody is the single shared body path for every request the daemon serves.
describe('readBody', () => {
  // A chunk boundary lands wherever the socket says it does. Decoding each Buffer on its own
  // turns any multi-byte character straddling one into U+FFFD, so a commit message or a
  // SKILL.md body with an emoji or an accented name came out corrupted.
  it('decodes a multi-byte character split across chunk boundaries', async () => {
    const text = 'héllo — 🚀 ünïcode';
    const buf = Buffer.from(text, 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < buf.length; i += 3) chunks.push(buf.subarray(i, i + 3));
    const req = Readable.from(chunks) as unknown as IncomingMessage;
    expect(await readBody(req)).toBe(text);
  });

  it('parses JSON whose payload was split mid-character', async () => {
    const payload = JSON.stringify({ message: 'fix: café ☕ handling' });
    const buf = Buffer.from(payload, 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < buf.length; i += 5) chunks.push(buf.subarray(i, i + 5));
    const { res } = resSpy();
    const parsed = await readJsonObject<{ message: string }>(
      Readable.from(chunks) as unknown as IncomingMessage, res,
    );
    expect(parsed?.message).toBe('fix: café ☕ handling');
  });

  it('has a default cap rather than buffering whatever is sent', () => {
    expect(MAX_BODY_BYTES).toBeGreaterThan(0);
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('rejects past the cap instead of growing the buffer', async () => {
    const req = Readable.from([Buffer.alloc(64, 0x61), Buffer.alloc(64, 0x61)]) as unknown as IncomingMessage;
    await expect(readBody(req, 100)).rejects.toThrow(/too large/i);
  });

  it('readJsonObject answers 413 for an oversized body', async () => {
    const { res } = resSpy();
    const req = Readable.from([Buffer.alloc(300, 0x61)]) as unknown as IncomingMessage;
    expect(await readJsonObject(req, res, { limit: 100 })).toBeNull();
    expect(res.statusCode).toBe(413);
  });

  it('readJsonBody answers null for an oversized body rather than rejecting', async () => {
    const req = Readable.from([Buffer.alloc(300, 0x61)]) as unknown as IncomingMessage;
    await expect(readJsonBody(req, 100)).resolves.toBeNull();
  });

  it('a body exactly at the cap still goes through', async () => {
    const req = Readable.from([Buffer.from('{"a":1}')]) as unknown as IncomingMessage;
    expect(await readBody(req, 7)).toBe('{"a":1}');
  });
});
