import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readPreparedState,
  writePreparedState,
  ensureE2bBaseTemplate,
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
  it('returns an empty schema-1 state when the file is absent', () => {
    expect(readPreparedState()).toEqual({ schema: 1 });
  });

  it('round-trips a base template record', () => {
    writePreparedState({
      schema: 1,
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
    expect(readPreparedState()).toEqual({ schema: 1 });
  });

  it('ensureE2bBaseTemplate throws with the prepare hint when no base exists', () => {
    expect(() => ensureE2bBaseTemplate()).toThrow(/agentbox prepare --provider e2b/);
  });

  it('ensureE2bBaseTemplate passes once a base is recorded', () => {
    writePreparedState({
      schema: 1,
      base: { templateId: 'tmpl_x:latest', createdAt: '2026-06-03T00:00:00Z' },
    });
    expect(() => ensureE2bBaseTemplate()).not.toThrow();
  });
});
