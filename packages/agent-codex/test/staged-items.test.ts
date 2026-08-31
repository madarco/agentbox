import { describe, expect, it } from 'vitest';
import { codexStagedItems } from '../src/staged-items.js';

describe('codexStagedItems', () => {
  it('treats prompts as a dir and everything else as a file', () => {
    expect(codexStagedItems(['config.toml', 'prompts', 'auth.json']).map((i) => i.kind)).toEqual([
      'file',
      'dir',
      'file',
    ]);
  });
});
