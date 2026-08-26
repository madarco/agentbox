import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Daytona fixes resources when the SNAPSHOT is baked and rejects them on the
 * create call, so a `--size` / `box.sizeDaytona` that disagrees is discarded.
 * The CLI asks this at `config set` and before queueing a create so the warning
 * reaches a terminal, rather than only a detached job's log.
 */
const state = vi.hoisted(() => ({
  value: null as {
    base?: { imageRef: string };
    extras?: { size?: string; effectiveSize?: string };
  } | null,
}));

vi.mock('../src/prepared-state.js', async (orig) => {
  const actual = await orig<typeof import('../src/prepared-state.js')>();
  return { ...actual, readPreparedDaytonaState: () => state.value };
});

const { sizeIgnoredReason } = await import('../src/provider-module.js');

beforeEach(() => {
  state.value = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('daytona sizeIgnoredReason', () => {
  it('warns when the requested size differs from the bake', () => {
    state.value = { base: { imageRef: 'snap' }, extras: { effectiveSize: '2-4-8' } };
    const why = sizeIgnoredReason('4-8-30');
    expect(why).toContain("size '4-8-30' is ignored");
    expect(why).toContain('2-4-8');
    // The message must carry the escape hatch, not just the complaint.
    expect(why).toContain('agentbox prepare --provider daytona --size 4-8-30 --force');
  });

  it('is silent when the requested size matches the bake', () => {
    state.value = { base: { imageRef: 'snap' }, extras: { effectiveSize: '4-8-30' } };
    expect(sizeIgnoredReason('4-8-30')).toBeNull();
  });

  it('falls back to the requested `size` for snapshots baked before effectiveSize', () => {
    state.value = { base: { imageRef: 'snap' }, extras: { size: '4-8-30' } };
    expect(sizeIgnoredReason('4-8-30')).toBeNull();
  });

  it('says "the default size" when the bake recorded nothing', () => {
    state.value = { base: { imageRef: 'snap' }, extras: {} };
    expect(sizeIgnoredReason('4-8-30')).toContain('the default size');
  });

  it('stays silent on a foreign size spec', () => {
    // A hetzner server type sitting in the generic `box.size` is not ours to
    // judge — `prepare` surfaces that. Warning here would be noise.
    state.value = { base: { imageRef: 'snap' }, extras: { effectiveSize: '2-4-8' } };
    expect(sizeIgnoredReason('cx23')).toBeNull();
    expect(sizeIgnoredReason('4-8')).toBeNull();
    expect(sizeIgnoredReason('')).toBeNull();
  });

  it('is silent with no prepared state at all', () => {
    state.value = null;
    // Nothing baked yet: `prepare` will bake AT this size, so there is no
    // mismatch. Warning would tell a first-run user their new setting is
    // ignored — the opposite of true.
    expect(sizeIgnoredReason('4-8-30')).toBeNull();
  });
});
