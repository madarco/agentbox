import { describe, expect, it } from 'vitest';
import { buildAgentDescriptors } from '@agentbox/sandbox-core';
import {
  recordAgents,
  registrationAgents,
  registrationToBoxRecord,
} from '../src/registration-to-record.js';
import type { BoxRegistration } from '../src/types.js';

// A stable, non-random token so assertions are deterministic.
const TOKEN = 'tok-fixed';
const freshToken = (): string => TOKEN;

function reg(overrides: Partial<BoxRegistration> = {}): BoxRegistration {
  return {
    boxId: 'box-1',
    token: 'reg-token',
    name: 'brave-otter',
    registeredAt: '2026-07-01T00:00:00.000Z',
    kind: 'cloud',
    backend: 'e2b',
    sandboxId: 'sbx-abc',
    createdAt: '2026-07-01T00:00:00.000Z',
    agent: 'claude',
    image: 'tmpl-xyz',
    webPort: 8080,
    originUrl: 'git@github.com:o/r.git',
    worktrees: [
      { containerPath: '/workspace', hostMainRepo: '/tmp/clone', branch: 'agentbox/brave-otter' },
    ],
    ...overrides,
  };
}

describe('registrationToBoxRecord', () => {
  it('rebuilds a drivable cloud record from an SDK-provider registration', () => {
    const rec = registrationToBoxRecord(reg(), {
      controlPlaneUrl: 'https://hub.example',
      freshToken,
    });
    expect(rec.id).toBe('box-1');
    expect(rec.name).toBe('brave-otter');
    expect(rec.provider).toBe('e2b');
    expect(rec.container).toBe('cloud:sbx-abc');
    expect(rec.image).toBe('tmpl-xyz');
    expect(rec.lastAgent).toBe('claude');
    expect(rec.cloud?.backend).toBe('e2b');
    expect(rec.cloud?.sandboxId).toBe('sbx-abc');
    expect(rec.cloud?.webPort).toBe(8080);
    expect(rec.cloud?.topology).toBe('control-plane');
    expect(rec.cloud?.controlPlaneUrl).toBe('https://hub.example');
    // No local clone → no worktree bookkeeping (the registration's hostMainRepo
    // is the control box's create-time temp clone, deleted after create).
    expect(rec.gitWorktrees).toBeUndefined();
    // SDK providers mint no per-box key → no ssh target (no bogus identityFile).
    expect(rec.ssh).toBeUndefined();
    // The relay token rides the registration; bridge token falls back to freshToken.
    expect(rec.relayToken).toBe('reg-token');
    expect(rec.cloud?.bridgeToken).toBe(TOKEN);
  });

  it('sets an ssh target with identityFile for a VPS provider with a publicHost', () => {
    const rec = registrationToBoxRecord(
      reg({ backend: 'hetzner', sandboxId: '12345', publicHost: '10.0.0.1' }),
      { controlPlaneUrl: 'https://hub.example', freshToken },
    );
    expect(rec.ssh?.host).toBe('10.0.0.1');
    expect(rec.ssh?.user).toBe('vscode');
    expect(rec.ssh?.identityFile).toMatch(/12345\/ssh\/id_ed25519$/);
  });

  it('builds local git worktree bookkeeping when a projectRoot is supplied (PC adopt)', () => {
    const rec = registrationToBoxRecord(reg(), {
      controlPlaneUrl: 'https://hub.example',
      projectRoot: '/home/me/proj',
      projectIndex: 3,
      freshToken,
    });
    expect(rec.projectRoot).toBe('/home/me/proj');
    expect(rec.projectIndex).toBe(3);
    expect(rec.workspacePath).toBe('/home/me/proj');
    expect(rec.gitWorktrees?.[0]).toMatchObject({
      kind: 'root',
      hostMainRepo: '/home/me/proj',
      containerPath: '/workspace',
      branch: 'agentbox/brave-otter',
    });
  });

  it('preserves existing local identity + tokens on re-adopt', () => {
    const existing = registrationToBoxRecord(reg(), {
      controlPlaneUrl: 'https://hub.example',
      freshToken: () => 'first-bridge',
    });
    const refreshed = registrationToBoxRecord(reg({ image: 'tmpl-new' }), {
      controlPlaneUrl: 'https://hub.example',
      existing,
      freshToken: () => 'second-bridge',
    });
    // Live tokens are kept (already injected in the running box); only new fields update.
    expect(refreshed.id).toBe(existing.id);
    expect(refreshed.cloud?.bridgeToken).toBe(existing.cloud?.bridgeToken);
    expect(refreshed.image).toBe('tmpl-new');
  });

  it('falls back to agentbox/<name> branch and freshToken when the registration is sparse', () => {
    const rec = registrationToBoxRecord(
      { boxId: 'b2', token: '', name: 'lone-wolf', registeredAt: '2026-07-01T00:00:00.000Z' },
      { controlPlaneUrl: '', freshToken },
    );
    expect(rec.provider).toBe('docker');
    expect(rec.cloud?.workspaceBranch).toBe('agentbox/lone-wolf');
    // No registration bridgeToken → freshToken fallback.
    expect(rec.cloud?.bridgeToken).toBe(TOKEN);
    expect(rec.lastAgent).toBeUndefined();
  });
});

/**
 * The decision path behind "an agentless hub box started from another PC runs
 * the OpenClaw gateway" (#426 sign-off): hub registration -> PC B adopts it
 * (`hub adopt`) -> PC B's start re-registers it with the record's agent ->
 * the box's `agents.list` asks PC B's relay -> descriptors.
 */
describe('agents.list for a box adopted on another PC', () => {
  function servicesAfterAdoptAndStart(agent: string | undefined): string[] {
    const rec = registrationToBoxRecord(reg({ agent }), {
      controlPlaneUrl: 'https://hub.example',
      freshToken,
    });
    // What `agentbox start` re-registers with (cloud-provider / lifecycle).
    const reregisteredAgent = rec.agents?.[0] ?? rec.lastAgent;
    const fromRegistration = registrationAgents({ agent: reregisteredAgent });
    const fromRecord = recordAgents(rec);
    expect(fromRegistration).toEqual(fromRecord);
    return buildAgentDescriptors({ boxAgents: fromRegistration })
      .agents.filter((a) => a.service)
      .map((a) => a.id);
  }

  it('starts no service agent in an agentless box', () => {
    expect(servicesAfterAdoptAndStart(undefined)).toEqual([]);
    expect(servicesAfterAdoptAndStart('none')).toEqual([]);
  });

  it('still starts the gateway of an adopted openclaw box', () => {
    expect(servicesAfterAdoptAndStart('openclaw')).toEqual(['openclaw']);
  });

  it('a claude box gets no service agent either', () => {
    expect(servicesAfterAdoptAndStart('claude')).toEqual([]);
  });
});
