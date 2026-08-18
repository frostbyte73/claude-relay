import { describe, it, expect } from 'vitest';
import { GATED_GROUPS } from '../../src/actions/registry.js';
// @ts-expect-error — plain-JS PWA module
import { GATED_GROUP_NAMES } from '../../src/pwa/vm/permissions.js';

describe('GATED_GROUPS <-> pwa vm parity', () => {
  it('the permissions page never diverges from which groups are actually gated', () => {
    expect(new Set(GATED_GROUP_NAMES)).toEqual(GATED_GROUPS);
  });
});
