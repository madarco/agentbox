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

/**
 * The agents' declared run-env has to reach BOTH surfaces on a cloud box.
 *
 * Docker delivers `spec.boxRunEnv` through `docker run -e`, where one container
 * env serves the ctl daemon and every login shell alike. A VPS has no such
 * store, and the two halves are reached differently:
 *
 *  - `env` is exported before `agentbox-ctl bootstrap`; the daemon is spawned
 *    with `env: process.env` and hands each task `{ ...process.env }`, so this
 *    is what the units see. Without it openclaw's onboard never saw
 *    `OPENCLAW_WORKSPACE_DIR` and wrote `~/.openclaw/workspace` — measured on a
 *    real hetzner box whose /workspace held the user's files all along.
 *  - `boxEnvFile` becomes /etc/agentbox/box.env, which the interactive tmux
 *    login shell sources. It does NOT inherit the daemon's env, so without this
 *    a hand-run `openclaw` would disagree with the service unit.
 *
 * The kick REWRITES box.env with `tee` on every create and resume, so a value
 * omitted here is gone for the life of the box, not merely stale.
 */
describe('buildBootstrapEnv agent run-env', () => {
  it('puts a declared run-env var on both surfaces', () => {
    const { env, boxEnvFile } = buildBootstrapEnv({
      ...base,
      agentRunEnv: { OPENCLAW_WORKSPACE_DIR: '/workspace' },
    });
    expect(env).toContain('OPENCLAW_WORKSPACE_DIR=/workspace');
    expect(boxEnvFile).toContain('OPENCLAW_WORKSPACE_DIR=/workspace');
  });

  it('adds nothing when no agent declares one', () => {
    const withNone = buildBootstrapEnv(base);
    const withEmpty = buildBootstrapEnv({ ...base, agentRunEnv: {} });
    expect(withEmpty.env).toEqual(withNone.env);
    expect(withEmpty.boxEnvFile).toEqual(withNone.boxEnvFile);
  });

  it('shell-quotes a value so box.env survives `set -a; . box.env`', () => {
    // box.env is sourced, not parsed: an unquoted space would split the value.
    const { boxEnvFile } = buildBootstrapEnv({
      ...base,
      agentRunEnv: { SOME_DIR: '/a b/c' },
    });
    const line = boxEnvFile.find((l) => l.startsWith('SOME_DIR='));
    expect(line).toBeDefined();
    expect(line).not.toBe('SOME_DIR=/a b/c');
    expect(line).toContain("'");
  });

  it('merges several agents without dropping either', () => {
    const { env } = buildBootstrapEnv({
      ...base,
      agentRunEnv: { A_ONE: '1', B_TWO: '2' },
    });
    expect(env).toContain('A_ONE=1');
    expect(env).toContain('B_TWO=2');
  });
});
