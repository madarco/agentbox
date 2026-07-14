import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { resolvePrepareLocation } from '../src/commands/prepare.js';

// Only the `box` slice is read; cast a minimal shape through unknown.
function makeCfg(box: Record<string, unknown> = {}): EffectiveConfig {
  return {
    box: {
      daytonaClass: 'linux-vm',
      daytonaRegion: '',
      hetznerLocation: '',
      digitaloceanRegion: '',
      ...box,
    },
  } as unknown as EffectiveConfig;
}

describe('resolvePrepareLocation', () => {
  it('leaves daytona unpinned when no region is explicitly configured', () => {
    // The class-derived region must NOT leak in here: `box.daytonaClass:
    // linux-vm` implies us-east-1, but prepare may still fall back to a
    // container bake, and us-east-1 has no container runners. Each bake path
    // derives its own region from the class it actually bakes.
    expect(resolvePrepareLocation('daytona', undefined, makeCfg())).toBeUndefined();
  });

  it('passes an explicitly pinned daytona region through', () => {
    expect(resolvePrepareLocation('daytona', undefined, makeCfg({ daytonaRegion: 'eu' }))).toBe('eu');
  });

  it('lets the CLI flag win over the configured region', () => {
    expect(resolvePrepareLocation('daytona', 'us', makeCfg({ daytonaRegion: 'eu' }))).toBe('us');
  });

  it('reads hetzner and digitalocean from their own keys', () => {
    expect(resolvePrepareLocation('hetzner', undefined, makeCfg({ hetznerLocation: 'fsn1' }))).toBe('fsn1');
    expect(resolvePrepareLocation('digitalocean', undefined, makeCfg({ digitaloceanRegion: 'fra1' }))).toBe(
      'fra1',
    );
  });

  it('gives providers with no location concept nothing', () => {
    expect(resolvePrepareLocation('vercel', undefined, makeCfg({ hetznerLocation: 'fsn1' }))).toBeUndefined();
    expect(resolvePrepareLocation('docker', undefined, makeCfg())).toBeUndefined();
  });

  it('treats a whitespace-only flag and absent config as unset', () => {
    expect(resolvePrepareLocation('hetzner', '   ', makeCfg())).toBeUndefined();
    expect(resolvePrepareLocation('daytona', undefined, undefined)).toBeUndefined();
  });
});
