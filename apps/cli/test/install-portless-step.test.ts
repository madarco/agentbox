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
  provider: 'docker',
  platform: 'darwin',
  engine: 'docker-desktop',
  enabled: undefined,
  yes: false,
  fullySetUp: false,
};

describe('decidePortlessStep', () => {
  it('asks on a fresh Mac with Docker Desktop', () => {
    expect(decidePortlessStep(fresh)).toBe('ask');
  });

  it('sets up without asking under -y', () => {
    expect(decidePortlessStep({ ...fresh, yes: true })).toBe('setup');
  });

  it('skips OrbStack (it has .orb.local) and non-mac docker hosts', () => {
    expect(decidePortlessStep({ ...fresh, engine: 'orbstack' })).toBe('skip');
    expect(decidePortlessStep({ ...fresh, platform: 'linux' })).toBe('skip');
  });

  it('skips docker when the engine is not Docker Desktop (docker info failed, Colima, …)', () => {
    expect(decidePortlessStep({ ...fresh, engine: 'other' })).toBe('skip');
    expect(decidePortlessStep({ ...fresh, engine: 'other', yes: true })).toBe('skip');
  });

  it('covers the loopback-URL clouds, not the public-URL ones', () => {
    for (const provider of ['hetzner', 'digitalocean', 'remote-docker']) {
      expect(decidePortlessStep({ ...fresh, provider, engine: 'other', platform: 'linux' })).toBe(
        'ask',
      );
    }
    for (const provider of ['daytona', 'vercel', 'e2b']) {
      expect(decidePortlessStep({ ...fresh, provider })).toBe('skip');
    }
  });

  it('never re-asks a past "no"', () => {
    expect(decidePortlessStep({ ...fresh, enabled: false })).toBe('skip');
    expect(decidePortlessStep({ ...fresh, enabled: false, yes: true })).toBe('skip');
  });

  it('repairs an opted-in host that lost part of the setup, silently when complete', () => {
    expect(decidePortlessStep({ ...fresh, enabled: true })).toBe('setup');
    expect(decidePortlessStep({ ...fresh, enabled: true, fullySetUp: true })).toBe('skip');
  });
});

// hetzner: the same flow as docker without the macOS gate this Linux test host fails.
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
    await runPortlessInstallStep({ provider: 'hetzner', enabled: undefined, yes: true });
    await runPortlessInstallStep({ provider: 'hetzner', enabled: true, yes: true });
    expect(setupOpts().length).toBe(2);
    expect(setupOpts().every((o) => o['allowRootPrompt'] === false)).toBe(true);
  });

  it('does not save a cancelled prompt as a "no"', async () => {
    h.confirm.mockResolvedValue(h.cancel);
    await runPortlessInstallStep({ provider: 'hetzner', enabled: undefined, yes: false });
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.setup).not.toHaveBeenCalled();
  });

  it('saves a "yes" and sets up with the password prompt allowed', async () => {
    h.confirm.mockResolvedValue(true);
    await runPortlessInstallStep({ provider: 'hetzner', enabled: undefined, yes: false });
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
    await runPortlessInstallStep({ provider: 'hetzner', enabled: true, yes: false });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(setupOpts()[0]).toEqual({ allowRootPrompt: true, allowModeChange: false });
  });

  it('treats a crash-looping boot service as needing repair', async () => {
    h.portless = { installed: true, proxyRunning: true };
    h.service = { installed: true, failing: true };
    await runPortlessInstallStep({ provider: 'hetzner', enabled: true, yes: false });
    expect(h.setup).toHaveBeenCalledTimes(1);
    h.setup.mockClear();
    h.service = { installed: true };
    await runPortlessInstallStep({ provider: 'hetzner', enabled: true, yes: false });
    expect(h.setup).not.toHaveBeenCalled();
  });
});
