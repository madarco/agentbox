import { describe, expect, it } from 'vitest';
import { buildBuilderSource } from '../src/prepare.js';
import { resolveVercelSnapshot } from '../src/backend.js';
import type { PreparedVercelState } from '../src/prepared-state.js';

const base = { snapshotId: 'snap_base', contextSha256: 'aaaa', createdAt: 'x' };
const claude = { snapshotId: 'snap_claude', contextSha256: 'cccc', createdAt: 'y' };

const withVariants: PreparedVercelState = { schema: 2, base, variants: { '': base, claude } };
const baseOnly: PreparedVercelState = { schema: 2, base, variants: { '': base } };

describe('resolveVercelSnapshot', () => {
  it('picks the variant baked for exactly this agent set', () => {
    expect(resolveVercelSnapshot(withVariants, { agents: ['claude'] })).toBe('snap_claude');
  });

  it('falls back to the agentless base when no variant was baked', () => {
    // THE regression this file exists for. After a base-only `prepare` -- the
    // documented first-run flow -- every create must still work: the box boots
    // the base and `ensureAgentInstalled` adds the agent at create. Throwing
    // here (the e2b bug on PR #330) breaks every create for a new user, and a
    // live test never sees it once the variant exists.
    expect(resolveVercelSnapshot(baseOnly, { agents: ['codex'] })).toBe('snap_base');
  });

  it('picks the base for an agentless create', () => {
    expect(resolveVercelSnapshot(withVariants, { agents: [] })).toBe('snap_base');
    expect(resolveVercelSnapshot(withVariants, {})).toBe('snap_base');
  });

  it('is order-insensitive about the agent set', () => {
    const two: PreparedVercelState = {
      ...withVariants,
      variants: {
        ...withVariants.variants,
        'claude,codex': { ...claude, snapshotId: 'snap_both' },
      },
    };
    expect(resolveVercelSnapshot(two, { agents: ['codex', 'claude'] })).toBe('snap_both');
  });

  it('an explicit checkpoint snapshot always wins', () => {
    // A checkpoint already carries whatever agents it was captured with, so the
    // agent set must not redirect it to a variant.
    expect(resolveVercelSnapshot(withVariants, { snapshot: 'snap_ckpt', agents: ['claude'] })).toBe(
      'snap_ckpt',
    );
  });

  it('returns undefined when nothing is prepared, so the caller throws its hint', () => {
    expect(resolveVercelSnapshot({ schema: 2 }, { agents: ['claude'] })).toBeUndefined();
  });
});

describe('buildBuilderSource', () => {
  it('a base bake boots the stock runtime', () => {
    expect(buildBuilderSource(undefined)).toEqual({ runtime: 'node24' });
  });

  it('a derived bake boots the base snapshot and never passes runtime', () => {
    // The SDK's create params are a union whose snapshot branch OMITS `runtime`.
    // Passing both is a type error; passing runtime with a snapshot source would
    // silently boot the wrong thing.
    const src = buildBuilderSource('snap_base');
    expect(src).toEqual({ source: { type: 'snapshot', snapshotId: 'snap_base' } });
    expect(src).not.toHaveProperty('runtime');
  });

  it('never enables snapshot eviction on the builder', () => {
    // A derived builder boots FROM the shared base, which Vercel reports as its
    // currentSnapshotId. A retention window with the default deleteEvicted:true
    // would evict and DELETE the base the moment we snapshot, breaking every
    // other box. No policy at all means no window exists.
    const src = buildBuilderSource('snap_base') as Record<string, unknown>;
    expect(src.keepLastSnapshots).toBeUndefined();
    expect(src.persistent).toBeUndefined();
  });
});
