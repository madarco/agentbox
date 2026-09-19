import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveConfig } from '@agentbox/config';
import {
  dockerProvidersHidden,
  isDockerProvider,
  dockerHiddenListHint,
  dockerHiddenMessage,
  dockerHiddenReason,
  localDockerUnsupportedWarning,
  remoteHubConfigured,
} from '../src/control-plane/remote-hub.js';

/** Minimal effective config carrying only the fields the gate reads. */
function cfg(
  controlPlaneUrl: string | undefined,
  mode: 'auto' | 'thin' | 'local',
): EffectiveConfig {
  return {
    relay: { controlPlaneUrl },
    hub: { mode },
  } as unknown as EffectiveConfig;
}

describe('isDockerProvider', () => {
  it('covers docker and remote-docker (matching boxOwningHubIsLocal)', () => {
    expect(isDockerProvider('docker')).toBe(true);
    expect(isDockerProvider('remote-docker')).toBe(true);
    expect(isDockerProvider('e2b')).toBe(false);
    expect(isDockerProvider('hetzner')).toBe(false);
  });
});

describe('dockerProvidersHidden', () => {
  it('auto: hidden only when a control box is configured', () => {
    expect(dockerProvidersHidden(cfg(undefined, 'auto'))).toBe(false);
    expect(dockerProvidersHidden(cfg('https://cp.example', 'auto'))).toBe(true);
  });

  it('local: never hidden — the escape hatch, even under a control box', () => {
    expect(dockerProvidersHidden(cfg(undefined, 'local'))).toBe(false);
    expect(dockerProvidersHidden(cfg('https://cp.example', 'local'))).toBe(false);
  });

  it('thin: always hidden, even with no control box configured', () => {
    expect(dockerProvidersHidden(cfg(undefined, 'thin'))).toBe(true);
    expect(dockerProvidersHidden(cfg('https://cp.example', 'thin'))).toBe(true);
  });

  it('agrees with remoteHubConfigured under the default auto mode', () => {
    for (const url of [undefined, 'https://cp.example']) {
      const c = cfg(url, 'auto');
      expect(dockerProvidersHidden(c)).toBe(remoteHubConfigured(c));
    }
  });
});

describe('dockerHiddenReason', () => {
  it('distinguishes a control box from forced thin mode', () => {
    expect(dockerHiddenReason(cfg('https://cp.example', 'auto'))).toBe(
      'a control box is configured',
    );
    expect(dockerHiddenReason(cfg(undefined, 'thin'))).toBe('hub.mode is set to thin');
    // thin + a control box still reads as the control box (one IS configured).
    expect(dockerHiddenReason(cfg('https://cp.example', 'thin'))).toBe(
      'a control box is configured',
    );
  });
});

describe('dockerHiddenMessage', () => {
  it('under a control box: never recommends hub.mode=local, points at what works', () => {
    for (const context of ['create', 'prepare', 'setup'] as const) {
      const controlBox = dockerHiddenMessage(cfg('https://cp.example', 'auto'), context);
      expect(controlBox).toContain('a control box is configured');
      expect(controlBox).toContain('Local docker alongside a control box is not supported.');
      expect(controlBox).toContain('hetzner|e2b|vercel|daytona');
      expect(controlBox).toContain('agentbox remote-docker share');
      expect(controlBox).not.toContain('hub.mode=local');
    }
  });

  it('prefers the named engine when one is known, still without hub.mode=local', () => {
    const msg = dockerHiddenMessage(cfg('https://cp.example', 'auto'), 'create', 'buildbox');
    expect(msg).toContain('agentbox remote-docker share buildbox');
    expect(msg).not.toContain('hub.mode=local');
  });

  it('thin mode with no control box: hub.mode=local is still the honest fix', () => {
    for (const context of ['create', 'prepare', 'setup'] as const) {
      const thin = dockerHiddenMessage(cfg(undefined, 'thin'), context);
      expect(thin).toContain('hub.mode is set to thin');
      expect(thin).toContain('hub.mode=local');
      expect(thin).not.toContain('not supported');
    }
    expect(dockerHiddenMessage(cfg(undefined, 'thin'), 'create', 'buildbox')).toContain(
      'hub.mode=local',
    );
  });

  it('thin mode WITH a control box reads as the control box (the stricter rule wins)', () => {
    const msg = dockerHiddenMessage(cfg('https://cp.example', 'thin'), 'create');
    expect(msg).toContain('Local docker alongside a control box is not supported.');
    expect(msg).not.toContain('hub.mode=local');
  });
});

describe('dockerHiddenListHint', () => {
  it('under a control box: says how to get rid of them, not how to re-enable docker', () => {
    const hint = dockerHiddenListHint(cfg('https://cp.example', 'auto'));
    expect(hint).toContain('agentbox destroy <name>');
    expect(hint).toContain('Local docker alongside a control box is not supported.');
    expect(hint).not.toContain('hub.mode=local');
  });

  it('thin mode with no control box keeps the re-enable hint', () => {
    expect(dockerHiddenListHint(cfg(undefined, 'thin'))).toContain('hub.mode=local');
  });
});

describe('localDockerUnsupportedWarning', () => {
  // `controlBoxIsThisMachine` reads ~/.agentbox/control-plane/deploy.json, so the
  // whole describe runs against a throwaway HOME (apps/cli tests have no isolation).
  let home = '';
  const realHome = process.env.HOME;
  const deployRecord = () => join(home, '.agentbox', 'control-plane', 'deploy.json');

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'agentbox-remote-hub-gate-'));
    process.env.HOME = home;
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(join(home, '.agentbox'), { recursive: true, force: true });
  });

  /** What `agentbox hub expose` leaves behind: the control box IS this machine. */
  function writeExposedDeployRecord(): void {
    mkdirSync(join(home, '.agentbox', 'control-plane'), { recursive: true });
    writeFileSync(deployRecord(), JSON.stringify({ provider: 'local' }));
  }

  it('fires for a docker create when hub.mode=local meets a control box', async () => {
    for (const provider of ['docker', 'remote-docker']) {
      const warning = await localDockerUnsupportedWarning(
        cfg('https://cp.example', 'local'),
        provider,
      );
      expect(warning).toContain('Local docker alongside a control box is not supported.');
      expect(warning).toContain('agentbox list');
      expect(warning).toContain('agentbox git');
    }
  });

  it('stays silent without a control box, and in auto/thin mode', async () => {
    expect(await localDockerUnsupportedWarning(cfg(undefined, 'local'), 'docker')).toBeNull();
    expect(
      await localDockerUnsupportedWarning(cfg('https://cp.example', 'auto'), 'docker'),
    ).toBeNull();
    expect(
      await localDockerUnsupportedWarning(cfg('https://cp.example', 'thin'), 'docker'),
    ).toBeNull();
  });

  it('stays silent for a cloud provider — the combination only costs docker boxes', async () => {
    expect(
      await localDockerUnsupportedWarning(cfg('https://cp.example', 'local'), 'hetzner'),
    ).toBeNull();
  });

  it('stays silent when the control box IS this machine (agentbox hub expose)', async () => {
    writeExposedDeployRecord();
    expect(
      await localDockerUnsupportedWarning(cfg('https://cp.example', 'local'), 'docker'),
    ).toBeNull();
  });

  it('fires again when the control box is a real VPS deploy', async () => {
    mkdirSync(join(home, '.agentbox', 'control-plane'), { recursive: true });
    writeFileSync(deployRecord(), JSON.stringify({ provider: 'hetzner' }));
    expect(
      await localDockerUnsupportedWarning(cfg('https://cp.example', 'local'), 'docker'),
    ).not.toBeNull();
  });
});
