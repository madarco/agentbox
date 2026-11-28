import { describe, expect, it } from 'vitest';
import type { DigitalOceanSize } from '../src/client.js';
import { digitaloceanPlacementVerdict } from '../src/placement-check.js';

function s(slug: string, vcpus: number, memory: number, regions: string[], available = true) {
  return { slug, vcpus, memory, disk: 80, available, regions } as DigitalOceanSize;
}

const SIZES = [
  s('s-2vcpu-4gb', 2, 4096, ['nyc3', 'fra1', 'sfo3']),
  s('s-4vcpu-8gb', 4, 8192, ['nyc3', 'fra1', 'sfo3', 'syd1']),
  s('s-8vcpu-16gb', 8, 16384, ['syd1']),
  s('c-4', 4, 8192, ['nyc3'], false),
];

describe('digitaloceanPlacementVerdict', () => {
  it('says yes where the size is offered', () => {
    expect(digitaloceanPlacementVerdict({ size: 's-4vcpu-8gb', location: 'syd1' }, SIZES)).toEqual({
      offered: true,
    });
  });

  it('checks the default size when none is given, and names bigger ones there', () => {
    expect(digitaloceanPlacementVerdict({ location: 'syd1' }, SIZES)).toEqual({
      offered: false,
      reason:
        'DigitalOcean size "s-2vcpu-4gb" is not offered in region "syd1". In syd1 you can pick s-4vcpu-8gb, s-8vcpu-16gb.',
    });
  });

  it('says when a size is sold out', () => {
    expect(digitaloceanPlacementVerdict({ size: 'c-4', location: 'nyc3' }, SIZES).reason).toMatch(
      /"c-4" is not currently available/,
    );
  });

  it('refuses an unknown region or size', () => {
    expect(
      digitaloceanPlacementVerdict({ size: 's-2vcpu-4gb', location: 'atl9' }, SIZES).reason,
    ).toMatch(/no size in region 'atl9'/);
    expect(digitaloceanPlacementVerdict({ size: 's-99', location: 'nyc3' }, SIZES).reason).toMatch(
      /"s-99" does not exist/,
    );
  });

  it('refuses a region the base snapshot is not in, naming the tier', () => {
    const snap = { name: 'agentbox-base', regions: ['nyc3'], min_disk_size: 20 } as never;
    const v = digitaloceanPlacementVerdict({ size: 's-2vcpu-4gb', location: 'fra1' }, SIZES, snap, [
      'claude',
    ]);
    expect(v.offered).toBe(false);
    expect(v.reason).toMatch(
      /claude snapshot "agentbox-base" does not exist in region "fra1".*--location fra1/,
    );
    expect(
      digitaloceanPlacementVerdict({ size: 's-2vcpu-4gb', location: 'nyc3' }, SIZES, snap),
    ).toEqual({ offered: true });
  });
});
