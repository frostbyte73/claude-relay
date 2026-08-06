import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonObject, readJsonObject } from '../../src/routes/util.js';

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
