import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub everything the step touches: docker, config, the Portless CLI, prompts.
const h = vi.hoisted(() => ({
  engine: 'docker-desktop' as string,
  portless: { installed: false, proxyRunning: false } as {
    installed: boolean;
    proxyRunning: boolean;
  },
  service: { installed: false } as { installed: boolean; failing?: boolean },
  setup: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
  setConfig: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  confirm: vi.fn(),
  cancel: Symbol('cancel'),
}));
vi.mock('@agentbox/sandbox-docker', () => ({
  detectEngine: vi.fn(async () => h.engine),
  detectPortless: vi.fn(async () => h.portless),
  portlessServiceHint: () => 'agentbox install portless',
  portlessServiceStatus: vi.fn(async () => h.service),
}));
vi.mock('../src/portless-prompt.js', () => ({ setupPortlessHost: h.setup }));
vi.mock('@agentbox/config', () => ({ setConfigValue: h.setConfig }));
vi.mock('@agentbox/cli-kit', () => ({
  confirm: h.confirm,
  isCancel: (v: unknown) => v === h.cancel,
  log: { info: vi.fn(), warn: vi.fn() },
  note: vi.fn(),
}));

import {
  decidePortlessStep,
  runPortlessInstallStep,
  type PortlessStepInput,
} from '../src/install-portless-step.js';

const fresh: PortlessStepInput = {
  dockerOffered: true,
  platform: 'darwin',
  engine: 'docker-desktop',
  enabled: undefined,
  yes: false,
  installed: false,
  fullySetUp: false,
};

describe('decidePortlessStep', () => {
  it('asks (default yes) on a fresh Mac with Docker Desktop', () => {
    expect(decidePortlessStep(fresh)).toBe('ask');
  });

  it('sets up without asking under -y', () => {
    expect(decidePortlessStep({ ...fresh, yes: true })).toBe('setup');
  });

  it('asks default-no on hosts that only need it for the alias clouds', () => {
    // OrbStack has .orb.local; 'other' is Colima/Rancher/Podman or no reachable docker.
    expect(decidePortlessStep({ ...fresh, engine: 'orbstack' })).toBe('ask-optional');
    expect(decidePortlessStep({ ...fresh, engine: 'other' })).toBe('ask-optional');
    expect(decidePortlessStep({ ...fresh, platform: 'linux', engine: 'other' })).toBe(
      'ask-optional',
    );
  });

  it('skips the optional offer under -y', () => {
    expect(decidePortlessStep({ ...fresh, engine: 'orbstack', yes: true })).toBe('skip');
    expect(decidePortlessStep({ ...fresh, platform: 'linux', yes: true })).toBe('skip');
  });

  it('asks default-yes wherever Portless is already installed', () => {
    expect(decidePortlessStep({ ...fresh, engine: 'orbstack', installed: true })).toBe('ask');
    expect(decidePortlessStep({ ...fresh, platform: 'linux', installed: true })).toBe('ask');
    expect(decidePortlessStep({ ...fresh, platform: 'linux', installed: true, yes: true })).toBe(
      'setup',
    );
  });

  it('narrows to a named --provider', () => {
    const linux = { ...fresh, platform: 'linux' as const, engine: 'other' as const };
    // The alias clouds want it outright, so -y still sets it up on Linux.
    for (const provider of ['hetzner', 'digitalocean', 'remote-docker']) {
      expect(decidePortlessStep({ ...linux, provider })).toBe('ask');
      expect(decidePortlessStep({ ...linux, provider, yes: true })).toBe('setup');
    }
    // The public-URL clouds never need it, even on Docker Desktop.
    for (const provider of ['daytona', 'vercel', 'e2b']) {
      expect(decidePortlessStep({ ...fresh, provider })).toBe('skip');
      expect(decidePortlessStep({ ...fresh, provider, yes: true })).toBe('skip');
    }
    expect(decidePortlessStep({ ...fresh, provider: 'docker' })).toBe('ask');
    expect(decidePortlessStep({ ...fresh, provider: 'docker', engine: 'orbstack' })).toBe('skip');
  });

  it('does not count Docker Desktop while local docker is not offered', () => {
    expect(decidePortlessStep({ ...fresh, dockerOffered: false })).toBe('ask-optional');
    expect(decidePortlessStep({ ...fresh, dockerOffered: false, yes: true })).toBe('skip');
  });

  it('skips Windows', () => {
    expect(decidePortlessStep({ ...fresh, platform: 'win32' })).toBe('skip');
    expect(decidePortlessStep({ ...fresh, platform: 'win32', enabled: true })).toBe('skip');
  });

  it('never re-asks a past "no"', () => {
    expect(decidePortlessStep({ ...fresh, enabled: false })).toBe('skip');
    expect(decidePortlessStep({ ...fresh, enabled: false, yes: true })).toBe('skip');
    expect(decidePortlessStep({ ...fresh, enabled: false, installed: true })).toBe('skip');
  });

  it('repairs an opted-in host that lost part of the setup, silently when complete', () => {
    expect(decidePortlessStep({ ...fresh, enabled: true })).toBe('setup');
    expect(
      decidePortlessStep({ ...fresh, platform: 'linux', engine: 'other', enabled: true }),
    ).toBe('setup');
    expect(decidePortlessStep({ ...fresh, enabled: true, fullySetUp: true })).toBe('skip');
  });
});

// The test host is Linux: no Docker Desktop, so a fresh host gets the optional prompt.
describe('runPortlessInstallStep', () => {
  beforeEach(() => {
    h.engine = 'docker-desktop';
    h.portless = { installed: false, proxyRunning: false };
    h.service = { installed: false };
    h.setup.mockClear();
    h.setConfig.mockClear();
    h.confirm.mockReset();
  });

  const setupOpts = () => h.setup.mock.calls.map((c) => c[0] as Record<string, unknown>);

  it('never asks for a password under -y', async () => {
    h.portless = { installed: true, proxyRunning: false };
    await runPortlessInstallStep({ dockerOffered: true, enabled: undefined, yes: true });
    await runPortlessInstallStep({ dockerOffered: true, enabled: true, yes: true });
    expect(setupOpts().length).toBe(2);
    expect(setupOpts().every((o) => o['allowRootPrompt'] === false)).toBe(true);
  });

  it('offers default-no on a host without Docker Desktop, and -y leaves it alone', async () => {
    h.confirm.mockResolvedValue(false);
    await runPortlessInstallStep({ dockerOffered: true, enabled: undefined, yes: false });
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(h.setConfig).toHaveBeenCalledWith(
      'global',
      'portless.enabled',
      false,
      expect.anything(),
      { raw: false },
    );
    h.setConfig.mockClear();
    await runPortlessInstallStep({ dockerOffered: true, enabled: undefined, yes: true });
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.setup).not.toHaveBeenCalled();
  });

  it('does not save a cancelled prompt as a "no"', async () => {
    h.confirm.mockResolvedValue(h.cancel);
    await runPortlessInstallStep({ dockerOffered: true, enabled: undefined, yes: false });
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.setup).not.toHaveBeenCalled();
  });

  it('saves a "yes" and sets up with the password prompt allowed', async () => {
    h.confirm.mockResolvedValue(true);
    await runPortlessInstallStep({ dockerOffered: true, enabled: undefined, yes: false });
    expect(h.setConfig).toHaveBeenCalledWith(
      'global',
      'portless.enabled',
      true,
      expect.anything(),
      {
        raw: false,
      },
    );
    expect(setupOpts()[0]?.['allowRootPrompt']).toBe(true);
  });

  it('repairs an opted-in host without asking, and never changes the proxy mode', async () => {
    await runPortlessInstallStep({ dockerOffered: true, enabled: true, yes: false });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(setupOpts()[0]).toEqual({ allowRootPrompt: true, allowModeChange: false });
  });

  it('treats a crash-looping boot service as needing repair', async () => {
    h.portless = { installed: true, proxyRunning: true };
    h.service = { installed: true, failing: true };
    await runPortlessInstallStep({ dockerOffered: true, enabled: true, yes: false });
    expect(h.setup).toHaveBeenCalledTimes(1);
    h.setup.mockClear();
    h.service = { installed: true };
    await runPortlessInstallStep({ dockerOffered: true, enabled: true, yes: false });
    expect(h.setup).not.toHaveBeenCalled();
  });
});
