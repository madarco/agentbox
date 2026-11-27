import type { EffectiveConfig } from '@agentbox/config';
import { describe, expect, it } from 'vitest';
import { parseCreateBox } from '../app/(dashboard)/api/v1/lib/validate';
// The CLI's own builder, not a hand-written copy of its output: the point is
// that what the CLI sends is what this hub accepts. A key the CLI starts
// emitting that the validator does not know fails here, not as a 400 on a
// user's create.
import { buildHubCreateOpts } from '../../cli/src/lib/hub-create-opts';

function cfg(box: Record<string, unknown> = {}): EffectiveConfig {
  return {
    box: {
      size: '',
      sizeHetzner: 'cx23',
      sizeDigitalocean: '',
      hetznerLocation: 'nbg1',
      digitaloceanRegion: '',
      imageRegistry: '',
      defaultCheckpoint: '',
      defaultCheckpointHetzner: '',
      defaultCheckpointDigitalocean: '',
      swap: 'auto',
      ...box,
    },
  } as unknown as EffectiveConfig;
}

function wire(providerName: string, c: EffectiveConfig, flags: Record<string, string>) {
  const { opts } = buildHubCreateOpts({ providerName, cfg: c, flags });
  return parseCreateBox({
    repoUrl: 'https://github.com/o/r.git',
    agent: 'none',
    provider: providerName,
    opts,
  });
}

describe("the CLI's create payload passes the hub validator", () => {
  it('--size, a pinned --location and a non-auto swap (hetzner)', () => {
    const r = wire('hetzner', cfg({ swap: '4G' }), { size: 'cx33', location: 'hel1' });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    expect(r.value.opts?.providerOptions).toMatchObject({
      size: 'cx33',
      location: 'hel1',
      locationPinned: true,
      swap: '4G',
    });
  });

  it('a configured location rides unpinned', () => {
    const r = wire('hetzner', cfg(), {});
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    expect(r.value.opts?.providerOptions).toMatchObject({ size: 'cx23', location: 'nbg1' });
    expect(r.value.opts?.providerOptions).not.toHaveProperty('locationPinned');
  });

  it('digitalocean with --location and swap', () => {
    const r = wire('digitalocean', cfg({ swap: 'off' }), { location: 'fra1' });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
  });
});
