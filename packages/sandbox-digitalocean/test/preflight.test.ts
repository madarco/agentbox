import { describe, expect, it } from 'vitest';
import { UserFacingError } from '@agentbox/core';
import { DigitalOceanApiError, type DigitalOceanSize, type DigitalOceanSnapshot } from '../src/client.js';
import { mapDigitalOceanProvisionError, validateSizeChoice, resolveProjectChoice } from '../src/preflight.js';

function size(over: Partial<DigitalOceanSize> & { slug: string }): DigitalOceanSize {
  return {
    memory: 4096,
    vcpus: 2,
    disk: 80,
    available: true,
    regions: ['nyc3', 'sfo3'],
    ...over,
  };
}

// A representative catalog: two available sizes (one small-disk), one
// unavailable, and a big size offered only in fra1.
const CATALOG: DigitalOceanSize[] = [
  size({ slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25 }),
  size({ slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80 }),
  size({ slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, regions: ['fra1'] }),
  size({ slug: 's-8vcpu-16gb', memory: 16384, vcpus: 8, disk: 320, available: false }),
];

function snapshot(over: Partial<DigitalOceanSnapshot> = {}): DigitalOceanSnapshot {
  return {
    id: '123',
    name: 'agentbox-base',
    created_at: '2026-01-01T00:00:00Z',
    regions: ['nyc3'],
    resource_id: '999',
    resource_type: 'droplet',
    min_disk_size: 80,
    size_gigabytes: 12,
    ...over,
  };
}

describe('validateSizeChoice', () => {
  it('accepts a valid size + region', () => {
    expect(() =>
      validateSizeChoice({ size: 's-2vcpu-4gb', region: 'nyc3' }, CATALOG, snapshot()),
    ).not.toThrow();
  });

  it('rejects an unknown size with suggestions', () => {
    expect(() =>
      validateSizeChoice({ size: 's-99vcpu', region: 'nyc3' }, CATALOG, null),
    ).toThrow(UserFacingError);
    try {
      validateSizeChoice({ size: 's-99vcpu', region: 'nyc3' }, CATALOG, null);
    } catch (e) {
      expect((e as Error).message).toContain('does not exist');
      expect((e as Error).message).toContain('s-1vcpu-1gb');
    }
  });

  it('rejects an unavailable size', () => {
    expect(() =>
      validateSizeChoice({ size: 's-8vcpu-16gb', region: 'nyc3' }, CATALOG, null),
    ).toThrow(/not currently available/);
  });

  it('rejects a size whose disk is smaller than the snapshot needs', () => {
    expect(() =>
      validateSizeChoice({ size: 's-1vcpu-1gb', region: 'nyc3' }, CATALOG, snapshot({ min_disk_size: 80 })),
    ).toThrow(/needs at least 80 GB/);
  });

  it('skips the disk check for stock string images (snapshot null)', () => {
    expect(() =>
      validateSizeChoice({ size: 's-1vcpu-1gb', region: 'nyc3' }, CATALOG, null),
    ).not.toThrow();
  });

  it('rejects a region the size is not offered in', () => {
    expect(() =>
      validateSizeChoice({ size: 's-2vcpu-4gb', region: 'fra1' }, CATALOG, null),
    ).toThrow(/not offered in region/);
  });
});

describe('mapDigitalOceanProvisionError', () => {
  const choice = { size: 's-2vcpu-4gb', region: 'nyc3' };

  it('passes non-DO errors through unchanged', () => {
    const err = new Error('boom');
    expect(mapDigitalOceanProvisionError(err, choice)).toBe(err);
  });

  it('maps a droplet-limit error to actionable guidance', () => {
    const err = new DigitalOceanApiError(422, 'unprocessable_entity', 'exceeded your droplet limit');
    const mapped = mapDigitalOceanProvisionError(err, choice);
    expect(mapped).toBeInstanceOf(UserFacingError);
    expect((mapped as Error).message).toContain('Droplet limit');
  });

  it('maps a capacity error to a region hint', () => {
    const err = new DigitalOceanApiError(503, 'service_unavailable', 'not available in this region');
    const mapped = mapDigitalOceanProvisionError(err, choice);
    expect(mapped).toBeInstanceOf(UserFacingError);
    expect((mapped as Error).message).toContain('no capacity');
  });

  it('passes an unrecognized DO error through unchanged', () => {
    const err = new DigitalOceanApiError(400, 'bad_request', 'something else');
    expect(mapDigitalOceanProvisionError(err, choice)).toBe(err);
  });
});

describe('resolveProjectChoice', () => {
  const projects = [
    { id: '8bab37f1-46a2-4ffb-a496-0e9bf27d1334', name: 'first-project', is_default: true },
    { id: 'ffffffff-0000-1111-2222-333333333333', name: 'client-x', is_default: false },
  ];

  it('resolves a project by name, case-insensitively', () => {
    expect(resolveProjectChoice('client-x', projects)).toBe(projects[1]!.id);
    expect(resolveProjectChoice('Client-X', projects)).toBe(projects[1]!.id);
  });

  it('passes an id straight through', () => {
    expect(resolveProjectChoice(projects[0]!.id, projects)).toBe(projects[0]!.id);
  });

  // This is the whole reason the check is a *preflight*: DO can only assign a
  // project after the Droplet exists, so a typo has to be caught before we spend
  // money, not after.
  it('throws and lists the real projects when the name is unknown', () => {
    expect(() => resolveProjectChoice('typo', projects)).toThrow(/not found/i);
    try {
      resolveProjectChoice('typo', projects);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('first-project (default)');
      expect(msg).toContain('client-x');
      expect(msg).toContain('box.digitaloceanProject');
    }
  });

  it('refuses an ambiguous name rather than guessing', () => {
    const dupes = [
      { id: 'a', name: 'same', is_default: false },
      { id: 'b', name: 'same', is_default: false },
    ];
    expect(() => resolveProjectChoice('same', dupes)).toThrow(/ambiguous/i);
  });

  it('an exact id match wins over a name that collides with it', () => {
    const tricky = [
      { id: 'abc', name: 'zzz', is_default: false },
      { id: 'xyz', name: 'abc', is_default: false },
    ];
    expect(resolveProjectChoice('abc', tricky)).toBe('abc');
  });
});
