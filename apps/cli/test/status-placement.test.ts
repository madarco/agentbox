import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import { cloudPlacementLines } from '../src/commands/inspect.js';

type Placed = Pick<BoxRecord, 'provider' | 'cloud'>;

function box(provider: string, cloud: Partial<NonNullable<BoxRecord['cloud']>>): Placed {
  return {
    provider: provider as BoxRecord['provider'],
    cloud: { backend: provider, sandboxId: 'x', ...cloud },
  };
}

describe('status size / location lines', () => {
  it('prints what the box recorded', () => {
    expect(
      cloudPlacementLines(box('hetzner', { sandboxId: '1', size: 'cx33', location: 'hel1' })),
    ).toEqual(['size          cx33', 'location      hel1']);
  });

  it('prefers where the provider says the box landed', () => {
    expect(
      cloudPlacementLines(box('digitalocean', { sandboxId: '1', landedLocation: 'nyc3' })),
    ).toEqual(['size          (provider default)', 'location      nyc3']);
  });

  it('says provider default when nothing was recorded', () => {
    expect(cloudPlacementLines(box('digitalocean', { sandboxId: '1' }))).toEqual([
      'size          (provider default)',
      'location      (provider default)',
    ]);
  });

  it('a bake-time size is the baked one, not a default', () => {
    expect(cloudPlacementLines(box('e2b', { sandboxId: 'x' }))).toEqual([
      'size          (set at bake)',
    ]);
  });

  it('drops the location line on a provider without one', () => {
    expect(cloudPlacementLines(box('vercel', { sandboxId: 'x', size: '4' }))).toEqual([
      'size          4',
    ]);
    // remote-docker has a size (container cpu/memory limits) but no location.
    expect(cloudPlacementLines(box('remote-docker', {}))).toEqual([
      'size          (provider default)',
    ]);
  });
});
