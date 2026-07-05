import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the two modules `evaluateBaseFreshness` reaches into so the test is
// pure: no fs, no SDKs, no network. We swap implementations per-test via
// vi.mocked().
vi.mock('@agentbox/sandbox-cloud', () => ({
  currentCloudBaseFingerprint: vi.fn(),
  // `baseFreshnessFromFingerprints` is a pure compare (no fs/SDK), so we give the
  // mock the real logic — its canonical impl + reason format are separately
  // covered by sandbox-cloud/test/base-freshness.test.ts.
  baseFreshnessFromFingerprints: (stored: string | undefined, live: string | undefined) => {
    if (!stored) return { state: 'unprepared' };
    if (!live) return { state: 'unknown' };
    if (stored !== live) {
      return {
        state: 'stale',
        reason: `baked runtime differs (base ${stored.slice(0, 12)}, current ${live.slice(0, 12)})`,
      };
    }
    return { state: 'fresh' };
  },
  // The other named imports of checkpoint-lookup.ts are unused by
  // evaluateBaseFreshness but must still be present so the module loads.
  probeCloudCheckpoint: vi.fn(),
  resolveCloudCheckpoint: vi.fn(),
}));
vi.mock('../src/provider/cloud-backend.js', () => ({
  cloudBackendForProvider: vi.fn(),
  currentCloudBaseFingerprintLive: vi.fn(),
}));
// checkpoint-lookup also pulls these in for evaluateCheckpoint (a sibling we
// don't test here); stub them so the import graph resolves.
vi.mock('@agentbox/sandbox-docker', () => ({
  computeDockerContextFingerprint: vi.fn(),
  imageExists: vi.fn(),
  readPreparedDockerState: vi.fn(),
  resolveCheckpoint: vi.fn(),
}));

import { evaluateBaseFreshness } from '../src/checkpoint-lookup.js';
import { currentCloudBaseFingerprint } from '@agentbox/sandbox-cloud';
import { currentCloudBaseFingerprintLive } from '../src/provider/cloud-backend.js';

describe('evaluateBaseFreshness', () => {
  beforeEach(() => {
    vi.mocked(currentCloudBaseFingerprint).mockReset();
    vi.mocked(currentCloudBaseFingerprintLive).mockReset();
  });

  it("returns 'fresh' for docker without consulting either fingerprint helper", async () => {
    const r = await evaluateBaseFreshness('docker');
    expect(r).toEqual({ state: 'fresh' });
    expect(currentCloudBaseFingerprint).not.toHaveBeenCalled();
    expect(currentCloudBaseFingerprintLive).not.toHaveBeenCalled();
  });

  it("returns 'unprepared' when no fingerprint is stored", async () => {
    vi.mocked(currentCloudBaseFingerprint).mockReturnValue(undefined);
    const r = await evaluateBaseFreshness('e2b');
    expect(r).toEqual({ state: 'unprepared' });
    // Live helper isn't consulted when there's no stored value to compare
    // against — saves a fingerprint compute on a clean install.
    expect(currentCloudBaseFingerprintLive).not.toHaveBeenCalled();
  });

  it("returns 'unknown' when the live fingerprint can't be computed", async () => {
    vi.mocked(currentCloudBaseFingerprint).mockReturnValue('a'.repeat(64));
    vi.mocked(currentCloudBaseFingerprintLive).mockResolvedValue(undefined);
    const r = await evaluateBaseFreshness('e2b');
    expect(r).toEqual({ state: 'unknown' });
  });

  it("returns 'unknown' when the live fingerprint helper throws", async () => {
    vi.mocked(currentCloudBaseFingerprint).mockReturnValue('a'.repeat(64));
    vi.mocked(currentCloudBaseFingerprintLive).mockRejectedValue(
      new Error('boom: missing ctl bundle'),
    );
    const r = await evaluateBaseFreshness('vercel');
    expect(r).toEqual({ state: 'unknown' });
  });

  it("returns 'fresh' when stored and live fingerprints match (checksum-only)", async () => {
    const sha = 'b'.repeat(64);
    vi.mocked(currentCloudBaseFingerprint).mockReturnValue(sha);
    vi.mocked(currentCloudBaseFingerprintLive).mockResolvedValue(sha);
    const r = await evaluateBaseFreshness('hetzner');
    expect(r).toEqual({ state: 'fresh' });
  });

  it("returns 'stale' with a checksum-shaped reason when they differ", async () => {
    const stored = 'a'.repeat(64);
    const current = 'c'.repeat(64);
    vi.mocked(currentCloudBaseFingerprint).mockReturnValue(stored);
    vi.mocked(currentCloudBaseFingerprintLive).mockResolvedValue(current);
    const r = await evaluateBaseFreshness('e2b');
    expect(r.state).toBe('stale');
    if (r.state !== 'stale') throw new Error('type guard');
    // The reason quotes the prefixes of both hashes, not any CLI version
    // strings — staleness is decided purely by content checksum.
    expect(r.reason).toContain(stored.slice(0, 12));
    expect(r.reason).toContain(current.slice(0, 12));
    expect(r.reason).not.toMatch(/cli|version/i);
  });
});
