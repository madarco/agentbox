import { describe, expect, it } from 'vitest';
import {
  preparedImageIdFor,
  refNamesPreparedBase,
  resolvedVariantForImage,
} from '../src/backend.js';
import type { PreparedDigitalOceanState } from '../src/prepared-state.js';

const base = {
  imageId: 100,
  description: 'agentbox-base-abc',
  createdAt: '2026-02-01T00:00:00.000Z',
  contextSha256: 'aaaa',
};
const claude = {
  imageId: 101,
  description: 'agentbox-claude-def',
  createdAt: '2026-02-02T00:00:00.000Z',
  contextSha256: 'cccc',
};

const withVariants: PreparedDigitalOceanState = {
  schema: 3,
  base,
  variants: { '': base, claude },
};
const baseOnly: PreparedDigitalOceanState = { schema: 3, base, variants: { '': base } };

describe('preparedImageIdFor', () => {
  it('picks the variant baked for exactly this agent set', () => {
    expect(preparedImageIdFor(withVariants, { agents: ['claude'] })).toBe(101);
  });

  it('falls back to the agentless base when no variant was baked', () => {
    // THE regression this file exists for. After a base-only `prepare` -- the
    // documented first-run path -- every create must still work: the box boots
    // the base and `ensureAgentInstalled` adds the agent at create. Throwing
    // here (the e2b bug on PR #330) breaks every create for a new user, and a
    // live test never sees it once the variant exists.
    expect(preparedImageIdFor(baseOnly, { agents: ['codex'] })).toBe(100);
  });

  it('picks the base for an agentless create', () => {
    expect(preparedImageIdFor(withVariants, { agents: [] })).toBe(100);
    expect(preparedImageIdFor(withVariants, {})).toBe(100);
  });

  it('is order- and case-insensitive about the agent set', () => {
    const two = {
      ...withVariants,
      variants: { ...withVariants.variants, 'claude,codex': { ...claude, imageId: 102 } },
    };
    expect(preparedImageIdFor(two, { agents: ['codex', 'claude'] })).toBe(102);
  });

  it('returns undefined when nothing is prepared at all, so the caller can throw its hint', () => {
    expect(preparedImageIdFor({ schema: 3 }, { agents: ['claude'] })).toBeUndefined();
    expect(preparedImageIdFor(null, { agents: [] })).toBeUndefined();
  });
});

describe('refNamesPreparedBase', () => {
  it('treats the pinned base description as "no explicit choice"', () => {
    // Every bake pins `box.imageDigitalocean` to the base's own name, so by
    // create time the ref usually names our base. Without this the pin silently
    // defeats variant selection and every box boots the agentless base.
    expect(refNamesPreparedBase(withVariants, { image: 'agentbox-base-abc' })).toBe(true);
    expect(refNamesPreparedBase(withVariants, { image: '100' })).toBe(true);
  });

  it('lets a real choice win', () => {
    expect(refNamesPreparedBase(withVariants, { image: 'ubuntu-24-04-x64' })).toBe(false);
    expect(refNamesPreparedBase(withVariants, { image: 'my-checkpoint' })).toBe(false);
  });

  it('never overrides an explicit snapshot — a checkpoint carries its own agents', () => {
    expect(
      refNamesPreparedBase(withVariants, {
        snapshot: 'agentbox-base-abc',
        image: 'agentbox-base-abc',
      }),
    ).toBe(false);
  });

  it('is false when nothing is prepared', () => {
    expect(refNamesPreparedBase({ schema: 3 }, { image: 'agentbox-base-abc' })).toBe(false);
  });
});

describe('resolvedVariantForImage', () => {
  it('reports the base when a claude create fell back to it', () => {
    // The whole point. `agentbox claude` on a base-only account resolves the
    // BASE, so a cross-region error must say "base snapshot" and suggest
    // re-baking the base -- not name a claude snapshot nobody has baked and
    // suggest `--agents claude`, which cannot place one in the target region.
    const resolved = preparedImageIdFor(baseOnly, { agents: ['claude'] });
    expect(resolved).toBe(100);
    expect(resolvedVariantForImage(baseOnly, resolved!)).toBe('');
  });

  it('reports the variant when one was actually baked', () => {
    const resolved = preparedImageIdFor(withVariants, { agents: ['claude'] });
    expect(resolved).toBe(101);
    expect(resolvedVariantForImage(withVariants, resolved!)).toBe('claude');
  });

  it('returns undefined for an id we never baked (a checkpoint, a stock slug)', () => {
    // Absent, not '' -- an unknown id must not be described as the base.
    expect(resolvedVariantForImage(withVariants, 999)).toBeUndefined();
    expect(resolvedVariantForImage(withVariants, 'ubuntu-24-04-x64')).toBeUndefined();
  });
});
