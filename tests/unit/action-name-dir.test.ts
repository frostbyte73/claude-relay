import { describe, it, expect } from 'vitest';
import { actionDirFor } from '../../src/actions/registry.js';

describe('actionDirFor', () => {
  it('splits a dotted name into <category>/<rest>', () => {
    const r = actionDirFor('/root', 'code.run-github-action');
    expect(r).toEqual({ dir: '/root/code/run-github-action', category: 'code', rest: 'run-github-action' });
  });
  it('rejects an invalid category', () => {
    expect(() => actionDirFor('/root', 'script.run-github-action')).toThrow(/category/);
  });
  it('rejects a name with no category separator', () => {
    expect(() => actionDirFor('/root', 'runthing')).toThrow();
  });
  it('rejects a rest with a path separator (traversal guard)', () => {
    expect(() => actionDirFor('/root', 'code.../etc')).toThrow();
  });
});
