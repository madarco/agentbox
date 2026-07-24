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

  it('remote-docker never routes to the hub (the control box cannot reach it)', async () => {
    const r = await resolveCreateRouting({
      providerName: 'remote-docker',
      effective: cfg('https://hub.example', true),
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
