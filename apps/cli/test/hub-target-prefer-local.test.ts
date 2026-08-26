import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable IO the mocks read. Hoisted so the vi.mock factories can close over it.
const state = {
  controlPlaneUrl: '' as string,
  loopback: null as string | null,
  hubPort: 8787,
  hubToken: 'LOCAL_TOKEN',
  apiKey: 'API_KEY',
};

// Override ONLY the IO resolveHubTarget touches; spread the real modules so every
// other transitive importer keeps working (no wholesale module replacement).
vi.mock('@agentbox/config', async (orig) => ({
  ...(await orig<typeof import('@agentbox/config')>()),
  loadEffectiveConfig: async () => ({
    effective: { relay: { controlPlaneUrl: state.controlPlaneUrl } },
  }),
}));
vi.mock('@agentbox/sandbox-core', async (orig) => ({
  ...(await orig<typeof import('@agentbox/sandbox-core')>()),
  getHubStatus: async () => ({ port: state.hubPort, token: state.hubToken }),
}));
vi.mock('../src/commands/control-plane.js', async (orig) => ({
  ...(await orig<typeof import('../src/commands/control-plane.js')>()),
  localExposedLoopbackUrl: async () => state.loopback,
}));
vi.mock('../src/control-plane/env-file.js', async (orig) => ({
  ...(await orig<typeof import('../src/control-plane/env-file.js')>()),
  loadControlPlaneEnv: () => {
    process.env.AGENTBOX_HUB_API_KEY = state.apiKey;
  },
}));

import { resolveHubTarget } from '../src/commands/hub.js';

describe('resolveHubTarget preferLocal', () => {
  beforeEach(() => {
    state.controlPlaneUrl = '';
    state.loopback = null;
    delete process.env.AGENTBOX_HUB_API_KEY;
  });
  afterEach(() => {
    delete process.env.AGENTBOX_HUB_API_KEY;
  });

  it('on a `hub expose`-d machine, preferLocal keeps the LOOPBACK target + API key (not the plain token)', async () => {
    // The bug: an exposed machine runs the password profile, so the plain local
    // hub token would 401. preferLocal must reuse the loopback branch.
    state.loopback = 'http://127.0.0.1:8787';
    state.controlPlaneUrl = 'https://cp.example';
    const t = await resolveHubTarget(undefined, { preferLocal: true });
    expect(t).toEqual({
      mode: 'remote',
      url: 'http://127.0.0.1:8787',
      token: 'API_KEY',
      onThisMachine: true,
    });
  });

  it('not exposed + a control box configured: preferLocal falls back to the plain local hub', async () => {
    state.controlPlaneUrl = 'https://cp.example';
    const t = await resolveHubTarget(undefined, { preferLocal: true });
    expect(t).toEqual({
      mode: 'local',
      url: 'http://127.0.0.1:8787',
      token: 'LOCAL_TOKEN',
      onThisMachine: true,
    });
  });

  it('without preferLocal, a configured control box wins (the default remote target)', async () => {
    state.controlPlaneUrl = 'https://cp.example';
    const t = await resolveHubTarget(undefined);
    expect(t).toEqual({
      mode: 'remote',
      url: 'https://cp.example',
      token: 'API_KEY',
      onThisMachine: false,
    });
  });

  it('no control box and not exposed: the plain local hub regardless of preferLocal', async () => {
    const t = await resolveHubTarget(undefined, { preferLocal: true });
    expect(t).toEqual({
      mode: 'local',
      url: 'http://127.0.0.1:8787',
      token: 'LOCAL_TOKEN',
      onThisMachine: true,
    });
  });
});

describe('onThisMachine (what `agentbox hub` branches on)', () => {
  beforeEach(() => {
    state.controlPlaneUrl = '';
    state.loopback = null;
    delete process.env.AGENTBOX_HUB_API_KEY;
  });

  it('is false only for a control box that is somewhere else', async () => {
    state.controlPlaneUrl = 'https://cp.example';
    expect((await resolveHubTarget()).onThisMachine).toBe(false);
  });

  it('is true for a `hub expose`-d machine, though the target is remote-shaped', async () => {
    // The distinction `mode` cannot make: this hub IS the control box AND is a
    // process here, so `agentbox hub` must start it rather than open it.
    state.loopback = 'http://127.0.0.1:8787';
    state.controlPlaneUrl = 'https://cp.example';
    const t = await resolveHubTarget();
    expect(t.mode).toBe('remote');
    expect(t.onThisMachine).toBe(true);
  });

  it('is true for the plain local hub', async () => {
    expect((await resolveHubTarget()).onThisMachine).toBe(true);
  });
});
