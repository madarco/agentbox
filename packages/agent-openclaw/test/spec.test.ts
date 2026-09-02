import { describe, expect, it } from 'vitest';
import { BOX_HOME, LIVE_DATABASE_EXCLUDES, isServiceAgent } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { openclawSyncModule } from '../src/index.js';

/**
 * The invariants Phase 0 established empirically, pinned as assertions.
 *
 * They are here rather than in a shared drift test because each one is about
 * OPENCLAW: what the PoC measured about this tool, and what would silently
 * regress if someone "fixed" the row from the older plan text (which was wrong
 * about the bind, the auth and the install size). The generic rules that apply
 * to any service agent are asserted in `apps/cli/test/agent-caps-wiring.test.ts`.
 */
const SPEC = resolveAgentSpec('openclaw');

describe('openclaw registry row', () => {
  it('is a service agent with a supervisor unit, not a TUI', () => {
    expect(isServiceAgent(SPEC)).toBe(true);
    expect(SPEC.service?.name).toBe('openclaw');
    expect(SPEC.service?.restart).toBe('always');
    expect(SPEC.caps.activitySource).toEqual([]);
  });

  it('publishes the gateway on the box web port, probed on /healthz', () => {
    // The gateway binds LOOPBACK and ctl's WebProxy forwards :80 to it inside
    // the same container, so the probe and the expose target 127.0.0.1 and the
    // row must never widen the bind. 80 is the only container port a box
    // publishes (`RESERVED_WEB_PORT`).
    expect(SPEC.service?.expose).toEqual({ port: 18789, as: 80 });
    expect(SPEC.service?.readyWhen?.http).toBe('http://127.0.0.1:18789/healthz');
  });

  it('never overrides gateway.bind or plants an auto-secret', () => {
    // Onboard writes `gateway.bind: loopback` and self-generates the auth token
    // (PoC #6, #7). Setting either from here would only widen exposure or fight
    // the tool for ownership of its own identity.
    const text = JSON.stringify(SPEC);
    expect(text).not.toContain('gateway.bind');
    expect(text).not.toContain('AGENTBOX_AUTO_SECRET');
  });

  it('onboards once, then renders the overlay, then starts', () => {
    const tasks = SPEC.service?.tasks ?? [];
    const onboard = tasks.find((t) => t.name === 'openclaw-onboard');
    const render = tasks.find((t) => t.name === 'openclaw-render');
    // `runOnce` is what keeps a warm boot from re-onboarding and replacing the
    // identity the box already has.
    expect(onboard?.runOnce).toBe('marker');
    expect(onboard?.command).toContain('--non-interactive');
    expect(render?.needs).toEqual(['openclaw-onboard']);
    expect(SPEC.service?.needs).toEqual(['openclaw-render']);
  });

  it('delegates the config merge to openclaw and gates on its own validator', () => {
    expect(SPEC.configRender).toEqual({
      file: `${BOX_HOME}/.openclaw/openclaw.json`,
      overlayKey: 'openclaw',
      applyCmd: 'openclaw config patch --stdin',
      dryRunFlag: '--dry-run',
      validate: 'openclaw config validate',
    });
  });

  it('reads the Control UI token from the raw config, not from `config get`', () => {
    // `openclaw config get gateway.auth.token` answers `__OPENCLAW_REDACTED__`.
    expect(SPEC.service?.urlFields).toEqual([
      { label: 'token', file: SPEC.configRender!.file, jsonPath: 'gateway.auth.token' },
    ]);
  });

  it('never pushes the host gateway identity into a box', () => {
    // One identity in two live gateways is the failure OpenClaw forbids, and a
    // host that happens to run openclaw itself is the way it would happen.
    const excludes = SPEC.staticPaths[0]!.exclude ?? [];
    for (const name of ['openclaw.json', 'config-journal-fingerprint.key', 'state']) {
      expect(excludes, name).toContain(name);
    }
    // `tmp` holds lock sqlites under a dir keyed by the box user's UID, which
    // differs per provider (docker 1000, vercel 1001, e2b 1002).
    expect(excludes).toContain('tmp');
    // …and the live-database deny is applied to every agent on top of these.
    expect(LIVE_DATABASE_EXCLUDES).toContain('*.sqlite*');
  });

  it('pulls back agent definitions and nothing identity-bearing', () => {
    expect(SPEC.pull).toEqual({ categories: ['agents'] });
  });

  it('installs on demand, with its own lifecycle scripts allowed', () => {
    // ~893 MB installed: baking it would add ~29% to a 3.1 GB base image AND
    // shift the build-context fingerprint, staling every provider's snapshot.
    expect(SPEC.install.recipe).toEqual({
      kind: 'npm',
      package: 'openclaw',
      allowScripts: true,
    });
    expect(SPEC.install.runAs).toBe('root');
  });

  it('runs its agents in /workspace', () => {
    expect(SPEC.boxRunEnv).toEqual({ OPENCLAW_WORKSPACE_DIR: '/workspace' });
  });
});

describe('openclaw docker module', () => {
  it('gives every box its own config volume', () => {
    // Two gateways sharing a state dir share one identity and its channel
    // pairings; `runServiceAgent` passes `isolate: true` unconditionally.
    const isolated = openclawSyncModule.resolveVolume({ isolate: true, boxId: 'abc123' });
    expect(isolated.volume).toBe(`${SPEC.dockerVolume}-abc123`);
    expect(openclawSyncModule.buildMounts(isolated, {}).extraVolumes).toEqual([
      `${isolated.volume}:${BOX_HOME}/.openclaw`,
    ]);
  });

  it('forwards the declared run-env, so docker agrees with the cloud path', () => {
    // The cloud providers merge `boxRunEnv` at provision time; docker only gets
    // it through this module. When it returned `{}`, the onboard task ran
    // without `OPENCLAW_WORKSPACE_DIR` and pointed the gateway's agents at
    // `~/.openclaw/workspace` instead of the project.
    const choice = openclawSyncModule.resolveVolume({ isolate: true, boxId: 'b' });
    expect(openclawSyncModule.buildMounts(choice, {}).env).toEqual(SPEC.boxRunEnv);
    expect(SPEC.boxRunEnv['OPENCLAW_WORKSPACE_DIR']).toBe('/workspace');
  });

  it('reports no tmux session rather than probing for one', async () => {
    // A daemon has none. Reporting one would put it in `agentbox list`'s AGENT
    // column as though it were attachable.
    await expect(openclawSyncModule.sessionInfo('container')).resolves.toMatchObject({
      running: false,
      startedAt: null,
    });
  });
});
