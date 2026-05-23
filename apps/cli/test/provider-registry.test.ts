import type { EffectiveConfig } from '@agentbox/config';
import type { BoxRecord } from '@agentbox/core';
import { describe, expect, it } from 'vitest';
import { getProvider, providerForBox, providerForCreate } from '../src/provider/registry.js';

function makeConfig(provider: 'docker' | 'daytona'): EffectiveConfig {
  // Only `box.provider` matters to the registry — everything else can be a stub.
  return { box: { provider } } as unknown as EffectiveConfig;
}

function box(provider: 'docker' | 'daytona' | undefined): BoxRecord {
  return {
    id: 'b1234567',
    name: 'b-demo',
    provider,
    container: 'agentbox-b-demo',
    image: 'agentbox/box:dev',
    workspacePath: '/tmp/ws',
    createdAt: '2026-05-12T12:00:00.000Z',
  };
}

describe('provider/registry', () => {
  it("getProvider('docker') returns a Provider whose name is 'docker'", async () => {
    const p = await getProvider('docker');
    expect(p.name).toBe('docker');
  });

  it("getProvider('daytona') resolves the Daytona provider", async () => {
    const p = await getProvider('daytona');
    expect(p.name).toBe('daytona');
  });

  it('getProvider rejects unknown names', async () => {
    await expect(getProvider('vercel' as 'docker')).rejects.toThrow(/unknown sandbox provider/);
  });

  it('providerForBox defaults a missing provider tag to docker', async () => {
    const p = await providerForBox(box(undefined));
    expect(p.name).toBe('docker');
  });

  it('providerForBox honours an explicit cloud tag', async () => {
    const p = await providerForBox(box('daytona'));
    expect(p.name).toBe('daytona');
  });

  it('providerForCreate: flag wins over config', async () => {
    const p = await providerForCreate({ flag: 'docker', config: makeConfig('daytona') });
    expect(p.name).toBe('docker');
  });

  it('providerForCreate: config used when no flag', async () => {
    const p = await providerForCreate({ config: makeConfig('docker') });
    expect(p.name).toBe('docker');
  });

  it('providerForCreate: rejects unknown flag values', async () => {
    await expect(
      providerForCreate({ flag: 'k8s', config: makeConfig('docker') }),
    ).rejects.toThrow(/unknown sandbox provider/);
  });
});
