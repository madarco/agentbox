import { describe, expect, it, vi } from 'vitest';

// The decision is pure; stub the modules the step imports for its side effects
// so loading it touches no docker, config or Portless binary.
vi.mock('@agentbox/sandbox-docker', () => ({
  detectEngine: vi.fn(),
  detectPortless: vi.fn(),
  portlessServiceHint: () => 'agentbox install portless',
  portlessServiceStatus: vi.fn(),
}));
vi.mock('../src/portless-prompt.js', () => ({ setupPortlessHost: vi.fn() }));

import { decidePortlessStep, type PortlessStepInput } from '../src/install-portless-step.js';

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
