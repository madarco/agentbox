import { describe, expect, it } from 'vitest';
import type { HetznerServerType } from '../src/client.js';
import { hetznerPlacementVerdict } from '../src/placement-check.js';

function t(
  name: string,
  cores: number,
  memory: number,
  at: string[],
  arch: 'x86' | 'arm' = 'x86',
  disk = 40,
) {
  return {
    id: 0,
    name,
    cores,
    memory,
    disk,
    architecture: arch,
    prices: [],
    locations: at.map((n) => ({ name: n })),
  } as unknown as HetznerServerType;
}

// The shape GET /server_types returned on 2026-11-28.
const TYPES = [
  t('cx23', 2, 4, ['fsn1', 'nbg1', 'hel1']),
  t('cpx21', 3, 4, ['ash', 'hil']),
  t('cpx11', 2, 2, ['ash', 'hil']),
  t('ccx13', 2, 8, ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin']),
  t('cax11', 2, 4, ['fsn1', 'nbg1', 'hel1'], 'arm'),
];
const LOCATIONS = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin'];

describe('hetznerPlacementVerdict', () => {
  it('says yes where the type is offered', () => {
    expect(hetznerPlacementVerdict({ size: 'cx23', location: 'hel1' }, TYPES, LOCATIONS)).toEqual({
      offered: true,
    });
  });

  it('checks the EU default type when no size is given in the EU', () => {
    expect(hetznerPlacementVerdict({ location: 'hel1' }, TYPES, LOCATIONS)).toEqual({
      offered: true,
    });
  });

  it('names x86 alternatives at the location, smallest first', () => {
    const v = hetznerPlacementVerdict({ size: 'cx23', location: 'ash' }, TYPES, LOCATIONS);
    expect(v.reason).toBe(
      'Hetzner server type "cx23" is not offered in location "ash". In ash you can pick cpx11, ccx13, cpx21.',
    );
  });

  it('refuses an unknown location or type', () => {
    expect(
      hetznerPlacementVerdict({ size: 'cx23', location: 'xyz1' }, TYPES, LOCATIONS).reason,
    ).toMatch(/no location 'xyz1'/);
    expect(
      hetznerPlacementVerdict({ size: 'cx99', location: 'nbg1' }, TYPES, LOCATIONS).reason,
    ).toMatch(/"cx99" does not exist/);
  });

  it('runs the create preflight: Arm and a too-small disk are refused', () => {
    expect(
      hetznerPlacementVerdict({ size: 'cax11', location: 'fsn1' }, TYPES, LOCATIONS).reason,
    ).toMatch(/ARM/);
    const v = hetznerPlacementVerdict({ size: 'cx23', location: 'nbg1' }, TYPES, LOCATIONS, {
      disk_size: 80,
    } as never);
    expect(v.offered).toBe(false);
    expect(v.reason).toMatch(/needs at least 80 GB/);
  });
});

describe('hetznerPlacementVerdict default size follows the location', () => {
  it('an empty size in ash is checked as cpx21, which is offered there', () => {
    expect(hetznerPlacementVerdict({ location: 'ASH' }, TYPES, LOCATIONS)).toEqual({
      offered: true,
    });
  });
});
