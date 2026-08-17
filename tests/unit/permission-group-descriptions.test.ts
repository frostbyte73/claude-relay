import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const groups = JSON.parse(readFileSync('config/permission-groups.default.json', 'utf8'));

describe('permission groups carry their own descriptions', () => {
  it('every shipped group has a non-empty description', () => {
    for (const name of ['core', 'read', 'pull', 'edit', 'push']) {
      expect(typeof groups[name].description, name).toBe('string');
      expect(groups[name].description.length, name).toBeGreaterThan(20);
    }
  });

  it('the description does not leak into the pattern arrays', () => {
    for (const name of ['core', 'read', 'pull', 'edit', 'push']) {
      expect(groups[name].alwaysAllow).not.toContain(groups[name].description);
    }
  });
});
