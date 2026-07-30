import { describe, expect, it } from 'vitest';
import { parseCheckpointCreate, parsePrune } from '../app/(dashboard)/api/v1/lib/validate';

describe('parseCheckpointCreate', () => {
  it('accepts an empty/absent body (auto-named, layered, not-default)', () => {
    expect(parseCheckpointCreate(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCheckpointCreate({})).toEqual({ ok: true, value: {} });
  });

  it('threads the capture options through', () => {
    const r = parseCheckpointCreate({
      name: 'warm',
      merged: true,
      setDefault: true,
      replace: false,
    });
    expect(r).toEqual({
      ok: true,
      value: { name: 'warm', merged: true, setDefault: true, replace: false },
    });
  });

  it('rejects wrong-typed fields', () => {
    expect(parseCheckpointCreate({ name: 5 }).ok).toBe(false);
    expect(parseCheckpointCreate({ merged: 'yes' }).ok).toBe(false);
    expect(parseCheckpointCreate('nope').ok).toBe(false);
  });
});

describe('parsePrune', () => {
  it('accepts an empty body (general prune, defaults)', () => {
    expect(parsePrune(undefined)).toEqual({ ok: true, value: {} });
    expect(parsePrune({})).toEqual({ ok: true, value: {} });
  });

  it('carries all / dryRun / provider', () => {
    expect(parsePrune({ all: true, dryRun: true, provider: 'e2b' })).toEqual({
      ok: true,
      value: { all: true, dryRun: true, provider: 'e2b' },
    });
  });

  it('rejects wrong-typed fields', () => {
    expect(parsePrune({ all: 'yes' }).ok).toBe(false);
    expect(parsePrune({ provider: 3 }).ok).toBe(false);
  });
});
