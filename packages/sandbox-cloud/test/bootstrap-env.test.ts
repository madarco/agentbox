import { describe, expect, it } from 'vitest';
import { buildBootstrapEnv, type KickCloudBootstrapArgs } from '../src/bootstrap-launch.js';

// Minimal args; buildBootstrapEnv only reads the plain fields, never the backend.
const base = {
  backend: {} as KickCloudBootstrapArgs['backend'],
  handle: {} as KickCloudBootstrapArgs['handle'],
  boxId: 'box-1',
  boxName: 'demo',
  relayUrl: 'http://127.0.0.1:8788',
  relayToken: 'rt',
  bridgeToken: 'bt',
  launchDockerd: true,
} satisfies KickCloudBootstrapArgs;

describe('buildBootstrapEnv control-plane threading', () => {
  it('classic-cloud (no controlPlaneUrl): no plane env, no lease flag', () => {
    const { env, boxEnvFile } = buildBootstrapEnv(base);
    expect(env.some((e) => e.startsWith('AGENTBOX_CONTROL_PLANE_URL='))).toBe(false);
    expect(boxEnvFile).not.toContain('AGENTBOX_GIT_LEASE=1');
  });

  it('control-plane: exports the plane URL (process env) + writes the lease flag (box.env)', () => {
    const { env, boxEnvFile } = buildBootstrapEnv({
      ...base,
      controlPlaneUrl: 'https://plane.example',
    });
    // Upstream URL goes to the daemon-inherited env[], not box.env.
    const cpEntry = env.find((e) => e.startsWith('AGENTBOX_CONTROL_PLANE_URL='));
    expect(cpEntry).toBeDefined();
    expect(cpEntry).toContain('https://plane.example');
    expect(boxEnvFile.some((e) => e.startsWith('AGENTBOX_CONTROL_PLANE_URL='))).toBe(false);
    // The non-secret lease flag goes to box.env (login-shell git push reads it).
    expect(boxEnvFile).toContain('AGENTBOX_GIT_LEASE=1');
    expect(env).not.toContain('AGENTBOX_GIT_LEASE=1');
  });
});
