import { describe, expect, it } from 'vitest';
import {
  defaultSizeFor,
  placementWarnings,
  resolveVpsPlacement,
  VPS_DEFAULTS,
} from '../src/control-plane/vps-placement.js';

// The rules themselves are tested in their packages (sandbox-hetzner and
// sandbox-digitalocean placement-rules). This covers the CLI's generic use of
// them and of the descriptor.
describe('resolveVpsPlacement without prompts', () => {
  it('uses the defaults when no flag is given', async () => {
    expect(await resolveVpsPlacement('hetzner', {}, false)).toEqual(VPS_DEFAULTS.hetzner);
    expect(await resolveVpsPlacement('digitalocean', {}, false)).toEqual(VPS_DEFAULTS.digitalocean);
  });

  it('lets each flag win on its own, trimmed', async () => {
    expect(await resolveVpsPlacement('hetzner', { location: ' hel1 ' }, false)).toEqual({
      location: 'hel1',
      size: 'cx23',
    });
    expect(
      await resolveVpsPlacement('digitalocean', { location: 'fra1', size: 's-4vcpu-8gb' }, false),
    ).toEqual({ location: 'fra1', size: 's-4vcpu-8gb' });
  });

  it('lowercases the location before using it', async () => {
    expect(await resolveVpsPlacement('hetzner', { location: 'ASH' }, false)).toEqual({
      location: 'ash',
      size: 'cpx21',
    });
    expect(await resolveVpsPlacement('digitalocean', { location: 'FRA1' }, false)).toEqual({
      location: 'fra1',
      size: 's-2vcpu-4gb',
    });
  });

  it('a bare location outside the EU gets that region default, not cx23', async () => {
    expect(await resolveVpsPlacement('hetzner', { location: 'sin' }, false)).toEqual({
      location: 'sin',
      size: 'cpx22',
    });
  });
});

describe('defaultSizeFor / placementWarnings read the descriptor and the packages', () => {
  it('takes the region default from the descriptor', () => {
    expect(defaultSizeFor('hetzner', 'hel1')).toBe('cx23');
    expect(defaultSizeFor('hetzner', 'hil')).toBe('cpx21');
    expect(defaultSizeFor('digitalocean', 'sfo3')).toBe('s-2vcpu-4gb');
  });

  it('routes warnings to the target package', () => {
    expect(placementWarnings('hetzner', 'cx23', 'ash')).toHaveLength(1);
    expect(placementWarnings('digitalocean', 's-1vcpu-2gb', 'nyc3')).toHaveLength(1);
    expect(placementWarnings('digitalocean', 's-2vcpu-4gb', 'nyc3')).toEqual([]);
  });
});
