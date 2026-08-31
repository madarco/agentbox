import { describe, expect, it } from 'vitest';
import { opencodeStagedItems } from '../src/staged-items.js';

describe('opencodeStagedItems', () => {
  it('marks auth + global config as files and extension dirs as dirs', () => {
    expect(
      opencodeStagedItems(['auth.json', 'config/opencode.json', 'config/skills']).map((i) => [
        i.rel,
        i.kind,
      ]),
    ).toEqual([
      ['auth.json', 'file'],
      ['config/opencode.json', 'file'],
      ['config/skills', 'dir'],
    ]);
  });

  it('keeps the config/ prefix in the rel while classifying on the basename', () => {
    // The `config/` prefix is the VOLUME layout; the file-vs-dir decision is
    // about the item itself, so stripping it for the test and keeping it in the
    // rel is the behaviour, not an accident.
    expect(opencodeStagedItems(['config/opencode.jsonc'])).toEqual([
      { rel: 'config/opencode.jsonc', label: 'config/opencode.jsonc', kind: 'file' },
    ]);
  });
});
