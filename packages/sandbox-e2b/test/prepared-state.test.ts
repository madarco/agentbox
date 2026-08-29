import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readPreparedState,
  writePreparedState,
  ensureE2bBaseTemplate,
  preparedEntryFor,
  preparedStatePath,
} from '../src/prepared-state.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentbox-e2b-prep-'));
  mkdirSync(join(home, '.agentbox'), { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

describe('e2b prepared-state', () => {
  it('returns an empty schema-2 state when the file is absent', () => {
    expect(readPreparedState()).toEqual({ schema: 2 });
  });

  it('round-trips a base template record', () => {
    writePreparedState({
      schema: 2,
      base: {
        templateId: 'tmpl_abc:latest',
        templateName: 'agentbox-base:latest',
        contextSha256: 'deadbeef',
        createdAt: '2026-06-03T00:00:00Z',
      },
    });
    const s = readPreparedState();
    expect(s.base?.templateId).toBe('tmpl_abc:latest');
    expect(s.base?.templateName).toBe('agentbox-base:latest');
    expect(s.base?.contextSha256).toBe('deadbeef');
  });

  it('refuses an unknown schema (treated as rebuild-needed)', () => {
    writeFileSync(
      preparedStatePath(),
      JSON.stringify({ schema: 99, base: { templateId: 'tmpl_x:latest' } }),
    );
    expect(readPreparedState()).toEqual({ schema: 2 });
  });

  it('lifts a schema-1 file forward by seeding the variants map from base', () => {
    // A v1 file has exactly one build and it is the agentless base, so the
    // migration is lossless — nobody has to rebuild a template to get variants.
    const base = { templateId: 'tmpl_v1:latest', createdAt: '2026-06-03T00:00:00Z' };
    writeFileSync(preparedStatePath(), JSON.stringify({ schema: 1, base }));
    const s = readPreparedState();
    expect(s.schema).toBe(2);
    expect(preparedEntryFor(s, '')).toEqual(base);
    // ...and it is NOT offered as any agent's variant.
    expect(preparedEntryFor(s, 'claude')).toBeUndefined();
  });

  it('keeps each agent set in its own slot', () => {
    const base = { templateId: 'tmpl_base:latest', createdAt: '2026-06-03T00:00:00Z' };
    const claude = { templateId: 'tmpl_claude:latest', createdAt: '2026-06-04T00:00:00Z' };
    writePreparedState({ schema: 2, base, variants: { '': base, claude } });
    const s = readPreparedState();
    // `base` is the AGENTLESS base even when a variant was built later —
    // provider-generic readers assume exactly that.
    expect(s.base?.templateId).toBe('tmpl_base:latest');
    expect(preparedEntryFor(s, '')?.templateId).toBe('tmpl_base:latest');
    expect(preparedEntryFor(s, 'claude')?.templateId).toBe('tmpl_claude:latest');
    expect(preparedEntryFor(s, 'codex')).toBeUndefined();
  });

  it('ensureE2bBaseTemplate throws with the prepare hint when no base exists', () => {
    expect(() => ensureE2bBaseTemplate()).toThrow(/agentbox prepare --provider e2b/);
  });

  it('ensureE2bBaseTemplate passes once a base is recorded', () => {
    writePreparedState({
      schema: 2,
      base: { templateId: 'tmpl_x:latest', createdAt: '2026-06-03T00:00:00Z' },
    });
    expect(() => ensureE2bBaseTemplate()).not.toThrow();
  });
});
