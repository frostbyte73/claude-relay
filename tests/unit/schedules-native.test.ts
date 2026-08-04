import { describe, it, expect } from 'vitest';
import { validateWhat } from '../../src/routes/schedules.js';

describe('validateWhat native', () => {
  it('accepts a native what with a handler', () => {
    expect(validateWhat({ kind: 'native', handler: 'pr-watcher' })).toBeNull();
  });
  it('rejects a native what without a handler', () => {
    expect(validateWhat({ kind: 'native' } as any)).toMatch(/handler/);
  });
});
