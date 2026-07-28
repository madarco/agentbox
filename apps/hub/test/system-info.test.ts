import { describe, expect, it } from 'vitest';
import { bakeVerdict, describeHubBuild, isBaked, type ProviderBake } from '../lib/system-info';

describe('describeHubBuild', () => {
  it('classifies a plain version as stable', () => {
    const b = describeHubBuild({ version: '0.28.0', source: null });
    expect(b.version).toBe('0.28.0');
    expect(b.channel).toBe('stable');
    expect(b.build).toBeNull();
  });

  it('classifies a -nightly. version as nightly', () => {
    const b = describeHubBuild({ version: '0.28.0-nightly.202607251430' });
    expect(b.channel).toBe('nightly');
  });

  it('renders an npm package build line and keeps the live channel', () => {
    const b = describeHubBuild({ version: '0.28.0', source: { kind: 'package', spec: '0.28.0' } });
    expect(b.build).toBe('@madarco/agentbox@0.28.0 (npm)');
    expect(b.channel).toBe('stable');
  });

  it('uses the ref as the channel for a source build', () => {
    const b = describeHubBuild({
      version: null,
      source: {
        kind: 'source',
        repoUrl: 'https://github.com/madarco/agentbox',
        repoRef: 'nightly',
      },
    });
    expect(b.channel).toBe('source (nightly)');
    expect(b.build).toBe('https://github.com/madarco/agentbox@nightly (built from source)');
  });

  it('reports null channel when nothing is known', () => {
    expect(describeHubBuild({ version: null }).channel).toBeNull();
  });
});

describe('isBaked', () => {
  // Freshness (when present) is authoritative. Only `unprepared` means no base;
  // `unknown` has a stored fingerprint (baked, freshness merely unverifiable).
  it('treats every freshness state except unprepared as baked', () => {
    expect(isBaked('fresh', false)).toBe(true);
    expect(isBaked('stale', false)).toBe(true);
    expect(isBaked('unknown', false)).toBe(true);
    expect(isBaked('unprepared', true)).toBe(false);
  });

  it('falls back to the on-disk record when freshness is absent', () => {
    expect(isBaked(undefined, true)).toBe(true);
    expect(isBaked(undefined, false)).toBe(false);
  });
});

describe('bakeVerdict', () => {
  const base: ProviderBake = { id: 'hetzner', label: 'Hetzner', baked: true };

  it('flags stale as a warning', () => {
    expect(bakeVerdict({ ...base, baseStatus: 'stale', baseStaleReason: 'x' }).tone).toBe('warn');
  });

  it('treats unbaked / unprepared as muted', () => {
    expect(bakeVerdict({ ...base, baked: false }).tone).toBe('muted');
    expect(bakeVerdict({ ...base, baked: false, baseStatus: 'unprepared' }).tone).toBe('muted');
  });

  it('treats fresh as ok', () => {
    expect(bakeVerdict({ ...base, baseStatus: 'fresh' }).tone).toBe('ok');
  });

  it('renders unknown as baked-but-unverifiable, not stale and not not-baked', () => {
    const v = bakeVerdict({ ...base, baseStatus: 'unknown' });
    expect(v.tone).toBe('ok');
    expect(v.text).toMatch(/could not be verified/i);
  });
});
