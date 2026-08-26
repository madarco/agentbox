import { beforeEach, describe, expect, it, vi } from 'vitest';

/** E2B fixes resources at TEMPLATE-build time and rejects per-create resources. */
const state = vi.hoisted(() => ({ value: {} as { base?: { size?: string } } }));

vi.mock('../src/prepared-state.js', async (orig) => {
  const actual = await orig<typeof import('../src/prepared-state.js')>();
  return { ...actual, readPreparedState: () => state.value };
});

const { sizeIgnoredReason } = await import('../src/provider-module.js');

beforeEach(() => {
  state.value = {};
});

describe('e2b sizeIgnoredReason', () => {
  it('warns when the requested size differs from the bake', () => {
    state.value = { base: { size: '2-4' } };
    const why = sizeIgnoredReason('4-8');
    expect(why).toContain("size '4-8' is ignored");
    expect(why).toContain('agentbox prepare --provider e2b --size 4-8 --force');
  });

  it('is silent when it matches', () => {
    state.value = { base: { size: '4-8' } };
    expect(sizeIgnoredReason('4-8')).toBeNull();
  });

  it('is silent with no template baked yet', () => {
    state.value = {};
    expect(sizeIgnoredReason('4-8')).toBeNull();
  });

  it('swallows a foreign spec rather than throwing', () => {
    // parseE2bSize THROWS on malformed input (unlike daytona's, which returns
    // undefined) — a hetzner server type in the generic box.size must not
    // blow up `agentbox config set`.
    state.value = { base: { size: '2-4' } };
    expect(() => sizeIgnoredReason('cx23')).not.toThrow();
    expect(sizeIgnoredReason('cx23')).toBeNull();
  });
});
