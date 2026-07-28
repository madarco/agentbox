import { describe, expect, it } from 'vitest';
import type { EffectiveConfig } from '@agentbox/config';
import { resolvePrepareRouting } from '../src/control-plane/route-prepare.js';

// The whole decision is pure — the caller resolves the hub API target and hands
// the result in — so a partial EffectiveConfig covering the two keys it reads
// (`relay.controlPlaneUrl`, `cloud.viaHub`) is enough.
function cfg(controlPlaneUrl: string | undefined, viaHub: boolean): EffectiveConfig {
  return { relay: { controlPlaneUrl }, cloud: { viaHub } } as unknown as EffectiveConfig;
}

const HUB = cfg('https://hub.example', true);

describe('resolvePrepareRouting', () => {
  it('bakes on the control box by default for a cloud provider', () => {
    expect(
      resolvePrepareRouting({ providerName: 'e2b', effective: HUB, hubApiAvailable: true }),
    ).toEqual({ where: 'hub' });
  });

  it('--local always wins, even with a control box configured', () => {
    expect(
      resolvePrepareRouting({
        providerName: 'e2b',
        effective: HUB,
        hubApiAvailable: true,
        forceLocal: true,
      }),
    ).toEqual({ where: 'local' });
  });

  it('--via-hub forces the hub (caller hard-fails on prereqs)', () => {
    expect(
      resolvePrepareRouting({
        providerName: 'e2b',
        effective: cfg(undefined, true),
        hubApiAvailable: false,
        forceHub: true,
      }),
    ).toEqual({ where: 'hub' });
  });

  it('--via-hub cannot send a docker bake to the control box', () => {
    // It would bake THAT machine's image and leave this one untouched. Unlike
    // create, nothing downstream re-checks the provider, so the flag must not
    // be able to reach the hub here.
    const r = resolvePrepareRouting({
      providerName: 'docker',
      effective: HUB,
      hubApiAvailable: true,
      forceHub: true,
    });
    expect(r.where).toBe('local');
    expect(r).toHaveProperty('fellBackReason', expect.stringContaining('nothing to bake'));
  });

  it('docker bakes locally — its base is a local image, not a portable snapshot', () => {
    expect(
      resolvePrepareRouting({ providerName: 'docker', effective: HUB, hubApiAvailable: true }),
    ).toEqual({ where: 'local' });
  });

  // remote-docker's base lands on a THIRD machine both sides reach, and
  // freshness is read off that engine — so unlike plain docker it is worth
  // baking on the control box, even though its *creates* can't route there.
  it('remote-docker bakes on the control box when it knows the host alias', () => {
    expect(
      resolvePrepareRouting({
        providerName: 'remote-docker',
        effective: HUB,
        hubApiAvailable: true,
        hubKnowsHost: true,
      }),
    ).toEqual({ where: 'hub' });
  });

  it('remote-docker stays local when the control box has no such host', () => {
    const r = resolvePrepareRouting({
      providerName: 'remote-docker',
      effective: HUB,
      hubApiAvailable: true,
      hubKnowsHost: false,
    });
    expect(r.where).toBe('local');
    expect(r).toHaveProperty('fellBackReason', expect.stringContaining('no such remote-docker host'));
  });

  it('--via-hub cannot conjure a host the control box does not have', () => {
    // It would SSH to that host as itself; there is nothing to force.
    expect(
      resolvePrepareRouting({
        providerName: 'remote-docker',
        effective: HUB,
        hubApiAvailable: true,
        hubKnowsHost: false,
        forceHub: true,
      }).where,
    ).toBe('local');
  });

  it('stays local when no control box is configured', () => {
    expect(
      resolvePrepareRouting({
        providerName: 'hetzner',
        effective: cfg(undefined, true),
        hubApiAvailable: false,
      }),
    ).toEqual({ where: 'local' });
  });

  it('cloud.viaHub=false keeps the bake here', () => {
    expect(
      resolvePrepareRouting({
        providerName: 'hetzner',
        effective: cfg('https://hub.example', false),
        hubApiAvailable: true,
      }),
    ).toEqual({ where: 'local' });
  });

  it('falls back with a reason when a flag the hub API cannot carry was passed', () => {
    const r = resolvePrepareRouting({
      providerName: 'daytona',
      effective: HUB,
      hubApiAvailable: true,
      localOnlyFlags: ['--size'],
    });
    expect(r.where).toBe('local');
    // Silently dropping an explicit flag is the failure this guards against.
    expect(r).toHaveProperty('fellBackReason', expect.stringContaining('--size'));
  });

  it('falls back with a reason when there is no API key for the control box', () => {
    const r = resolvePrepareRouting({
      providerName: 'e2b',
      effective: HUB,
      hubApiAvailable: false,
    });
    expect(r.where).toBe('local');
    expect(r).toHaveProperty('fellBackReason', expect.stringContaining('hub setup'));
  });
});
