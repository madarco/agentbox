import { describe, expect, it } from 'vitest';
import { UserFacingError } from '@agentbox/core';
import { HetznerApiError, type HetznerImage, type HetznerServerType } from '../src/client.js';
import { mapHetznerProvisionError, validateServerChoice } from '../src/preflight.js';

function serverType(over: Partial<HetznerServerType> & { name: string }): HetznerServerType {
  return {
    id: 1,
    cores: 2,
    memory: 4,
    disk: 40,
    architecture: 'x86',
    prices: [{ location: 'nbg1' }, { location: 'fsn1' }],
    ...over,
  };
}

// A representative catalog: two current x86 types, one ARM (cax), one
// deprecated x86, and a bigger type offered only in fsn1.
const CATALOG: HetznerServerType[] = [
  serverType({ id: 1, name: 'cx23', cores: 2, memory: 4, disk: 40 }),
  serverType({ id: 2, name: 'cx33', cores: 4, memory: 8, disk: 80 }),
  serverType({
    id: 3,
    name: 'ccx23',
    cores: 4,
    memory: 16,
    disk: 160,
    prices: [{ location: 'fsn1' }],
  }),
  serverType({ id: 4, name: 'cax31', architecture: 'arm', cores: 8, memory: 16, disk: 80 }),
  serverType({
    id: 5,
    name: 'cx22',
    cores: 2,
    memory: 4,
    disk: 40,
    deprecation: { unavailable_after: '2026-09-01T00:00:00+00:00' },
  }),
];

function image(over: Partial<HetznerImage> = {}): HetznerImage {
  return {
    id: 100,
    type: 'snapshot',
    status: 'available',
    description: 'agentbox-base',
    disk_size: 40,
    architecture: 'x86',
    created: '2026-01-01T00:00:00+00:00',
    labels: {},
    ...over,
  };
}

describe('validateServerChoice', () => {
  it('accepts a current x86 type in an offered location', () => {
    expect(() =>
      validateServerChoice({ serverType: 'cx23', location: 'nbg1' }, CATALOG, image()),
    ).not.toThrow();
  });

  it('rejects an unknown type and suggests valid ones', () => {
    try {
      validateServerChoice({ serverType: 'cx99', location: 'nbg1' }, CATALOG, image());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/does not exist/);
      expect(msg).toContain('cx23');
      // Neither the ARM nor the deprecated type should be suggested.
      expect(msg).not.toContain('cax31');
      expect(msg).not.toContain('cx22');
    }
  });

  it('rejects an ARM (cax) type with an x86-only message', () => {
    try {
      validateServerChoice({ serverType: 'cax31', location: 'nbg1' }, CATALOG, image());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      expect((err as Error).message).toMatch(/x86-only|ARM/);
    }
  });

  it('rejects a deprecated type', () => {
    try {
      validateServerChoice({ serverType: 'cx22', location: 'nbg1' }, CATALOG, image());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      expect((err as Error).message).toMatch(/deprecated/);
      expect((err as Error).message).toContain('2026-09-01');
    }
  });

  it('rejects a type whose disk is smaller than the base image', () => {
    // cx23 has a 40 GB disk; a 160 GB base image doesn't fit.
    try {
      validateServerChoice({ serverType: 'cx23', location: 'nbg1' }, CATALOG, image({ disk_size: 160 }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      expect((err as Error).message).toMatch(/40 GB disk.*at least 160 GB/s);
    }
  });

  it('skips the disk check when the image is null (stock string ref)', () => {
    expect(() =>
      validateServerChoice({ serverType: 'cx23', location: 'nbg1' }, CATALOG, null),
    ).not.toThrow();
  });

  it('rejects a location where the type is not offered and lists where it is', () => {
    // ccx23 is only offered in fsn1.
    try {
      validateServerChoice({ serverType: 'ccx23', location: 'nbg1' }, CATALOG, image({ disk_size: 40 }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UserFacingError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/not offered in location "nbg1"/);
      expect(msg).toContain('fsn1');
      expect(msg).toMatch(/--location/);
    }
  });

  it('accepts a type in its offered non-default location', () => {
    expect(() =>
      validateServerChoice({ serverType: 'ccx23', location: 'fsn1' }, CATALOG, image({ disk_size: 40 })),
    ).not.toThrow();
  });
});

describe('mapHetznerProvisionError', () => {
  const choice = { serverType: 'ccx23', location: 'fsn1' };

  it('maps resource_limit_exceeded to account-limit guidance', () => {
    const err = new HetznerApiError(403, 'resource_limit_exceeded', 'limit reached');
    const mapped = mapHetznerProvisionError(err, choice);
    expect(mapped).toBeInstanceOf(UserFacingError);
    const msg = (mapped as Error).message;
    expect(msg).toMatch(/resource limit/i);
    expect(msg).toContain('console.hetzner.cloud');
    // Original message preserved.
    expect(msg).toContain('limit reached');
  });

  it('maps resource_unavailable to a try-another-location hint', () => {
    const err = new HetznerApiError(409, 'resource_unavailable', 'no capacity');
    const mapped = mapHetznerProvisionError(err, choice);
    expect(mapped).toBeInstanceOf(UserFacingError);
    const msg = (mapped as Error).message;
    expect(msg).toContain('ccx23');
    expect(msg).toContain('fsn1');
    expect(msg).toMatch(/--location/);
    expect(msg).toContain('no capacity');
  });

  it('maps placement_error the same way as resource_unavailable', () => {
    const err = new HetznerApiError(409, 'placement_error', 'placement failed');
    const mapped = mapHetznerProvisionError(err, choice);
    expect(mapped).toBeInstanceOf(UserFacingError);
    expect((mapped as Error).message).toMatch(/no capacity/);
  });

  it('passes through an unrecognized Hetzner error code unchanged', () => {
    const err = new HetznerApiError(400, 'invalid_input', 'bad field');
    expect(mapHetznerProvisionError(err, choice)).toBe(err);
  });

  it('passes through a non-Hetzner error unchanged', () => {
    const err = new Error('socket hang up');
    expect(mapHetznerProvisionError(err, choice)).toBe(err);
  });
});
