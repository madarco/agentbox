import { describe, expect, it } from 'vitest';
import type { EffectiveConfig } from '@agentbox/config';
import { resolveCreateRouting } from '../src/control-plane/route-create.js';

// Only the flag/provider/config gating is exercised here — every case below
// returns BEFORE the origin/admin-token IO (that path is covered by the live
// smoke). A partial EffectiveConfig is enough: these branches read only
// `relay.controlPlaneUrl` and `cloud.viaHub`.
function cfg(controlPlaneUrl: string | undefined, viaHub: boolean): EffectiveConfig {
  return { relay: { controlPlaneUrl }, cloud: { viaHub } } as unknown as EffectiveConfig;
}

const ROOT = '/nonexistent-project';

describe('resolveCreateRouting — gating (no IO branches)', () => {
  it('--local always wins, even with a hub configured', async () => {
    const r = await resolveCreateRouting({
      providerName: 'e2b',
      effective: cfg('https://hub.example', true),
      projectRoot: ROOT,
      forceLocal: true,
    });
    expect(r).toEqual({ where: 'local' });
  });

  it('--via-hub forces the hub (caller validates prereqs)', async () => {
    const r = await resolveCreateRouting({
      providerName: 'e2b',
      effective: cfg(undefined, true),
      projectRoot: ROOT,
      forceHub: true,
    });
    expect(r).toEqual({ where: 'hub' });
  });

  it('docker never routes to the hub', async () => {
    const r = await resolveCreateRouting({
      providerName: 'docker',
      effective: cfg('https://hub.example', true),
      projectRoot: ROOT,
    });
    expect(r).toEqual({ where: 'local' });
  });

  // A remote-docker create names an ENGINE; with no alias there is nothing the
  // control box could be asked to reach, so it stays local and says why. (The
  // shared-engine case does IO — the live smoke covers it.)
  it('remote-docker with no engine alias stays local, with a reason', async () => {
    const r = await resolveCreateRouting({
      providerName: 'remote-docker',
      effective: cfg('https://hub.example', true),
      projectRoot: ROOT,
    });
    expect(r.where).toBe('local');
    expect(r.where === 'local' && r.fellBackReason).toMatch(/no remote-docker host/);
  });

  it('cloud.viaHub=false keeps a remote-docker engine local without probing', async () => {
    const r = await resolveCreateRouting({
      providerName: 'remote-docker',
      remoteHost: 'buildbox',
      effective: cfg('https://hub.example', false),
      projectRoot: ROOT,
    });
    expect(r).toEqual({ where: 'local' });
  });

  it('a cloud provider stays local when no control box is configured', async () => {
    const r = await resolveCreateRouting({
      providerName: 'e2b',
      effective: cfg(undefined, true),
      projectRoot: ROOT,
    });
    expect(r).toEqual({ where: 'local' });
  });

  it('cloud.viaHub=false forces local even with a hub configured', async () => {
    const r = await resolveCreateRouting({
      providerName: 'e2b',
      effective: cfg('https://hub.example', false),
      projectRoot: ROOT,
    });
    expect(r).toEqual({ where: 'local' });
  });
});
