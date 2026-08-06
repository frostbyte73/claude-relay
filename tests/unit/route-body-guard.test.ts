import { describe, it, expect } from 'vitest';
import { parseJsonObject } from '../../src/routes/util.js';

describe('parseJsonObject', () => {
  it('accepts a plain object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('{}')).toEqual({});
  });

  // Each of these parses successfully today and reaches the route handler, which
  // then destructures or `in`-checks it and crashes to a 500.
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
