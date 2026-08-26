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
      hubGitAuth: 'app',
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

  /**
   * `auto` used to lease whenever a control plane was configured, which assumed
   * every hub could mint per-box tokens. A `gh`-mode hub holds ONE broad token
   * that must never enter a box, so `auto` there has to route through the relay
   * instead — the box gets no credential and asks the hub to push for it.
   */
  describe('auto push mode follows the hub git-auth mode', () => {
    const withHub = (hubGitAuth?: 'gh' | 'app'): string[] =>
      buildBootstrapEnv({ ...base, controlPlaneUrl: 'https://plane.example', hubGitAuth })
        .boxEnvFile;

    it('gh-mode hub: no lease flag, so the box uses the relay bundle path', () => {
      expect(withHub('gh')).not.toContain('AGENTBOX_GIT_LEASE=1');
    });

    it('app-mode hub: leases, exactly as before this default flipped', () => {
      expect(withHub('app')).toContain('AGENTBOX_GIT_LEASE=1');
    });

    it('omitted defaults to gh, matching the config default', () => {
      expect(withHub(undefined)).not.toContain('AGENTBOX_GIT_LEASE=1');
    });

    it('explicit lease still forces leasing even on a gh-mode hub', () => {
      // The escape hatch: a user who configured an App by hand keeps control.
      const { boxEnvFile } = buildBootstrapEnv({
        ...base,
        controlPlaneUrl: 'https://plane.example',
        hubGitAuth: 'gh',
        gitPushMode: 'lease',
      });
      expect(boxEnvFile).toContain('AGENTBOX_GIT_LEASE=1');
    });

    it('never leases without a control plane, whatever the hub mode', () => {
      const { boxEnvFile } = buildBootstrapEnv({ ...base, hubGitAuth: 'app' });
      expect(boxEnvFile).not.toContain('AGENTBOX_GIT_LEASE=1');
    });
  });
});
