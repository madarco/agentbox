import { describe, expect, it } from 'vitest';
import {
  defaultSizeFor,
  hetznerLocationWarning,
  hubSizeWarning,
  resolveVpsPlacement,
  VPS_DEFAULTS,
} from '../src/control-plane/vps-placement.js';

describe('hubSizeWarning (control-box floor)', () => {
  it('accepts the defaults and anything larger', () => {
    expect(hubSizeWarning('hetzner', 'cx23')).toBeNull();
    expect(hubSizeWarning('hetzner', 'cpx31')).toBeNull();
    expect(hubSizeWarning('digitalocean', 's-2vcpu-4gb')).toBeNull();
    expect(hubSizeWarning('digitalocean', 's-8vcpu-16gb')).toBeNull();
  });

  it('warns on a hetzner type under 2 vCPU / 4 GB, and on Arm', () => {
    expect(hubSizeWarning('hetzner', 'cpx11')).toMatch(/below/);
    expect(hubSizeWarning('hetzner', 'CX11')).toMatch(/below/);
    expect(hubSizeWarning('hetzner', 'cpx12')).toMatch(/below/);
    expect(hubSizeWarning('hetzner', 'cax21')).toMatch(/Arm/);
  });

  it('reads the shape out of a DigitalOcean slug', () => {
    expect(hubSizeWarning('digitalocean', 's-1vcpu-2gb')).toMatch(/below/);
    expect(hubSizeWarning('digitalocean', 's-2vcpu-2gb')).toMatch(/below/);
    expect(hubSizeWarning('digitalocean', 's-1vcpu-512mb-10gb')).toMatch(/below/);
    // An opaque slug says nothing, so it is not second-guessed.
    expect(hubSizeWarning('digitalocean', 'c-4')).toBeNull();
  });
});

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
});

describe('hetzner size follows the location', () => {
  it('defaults to a floor-sized type each location offers', () => {
    expect(defaultSizeFor('hetzner', 'hel1')).toBe('cx23');
    expect(defaultSizeFor('hetzner', 'ash')).toBe('cpx21');
    expect(defaultSizeFor('hetzner', 'hil')).toBe('cpx21');
    expect(defaultSizeFor('hetzner', 'sin')).toBe('cpx22');
    expect(defaultSizeFor('digitalocean', 'sfo3')).toBe('s-2vcpu-4gb');
  });

  it('a bare --location outside the EU does not land on cx23', async () => {
    expect(await resolveVpsPlacement('hetzner', { location: 'ash' }, false)).toEqual({
      location: 'ash',
      size: 'cpx21',
    });
  });

  it('warns on a line the location does not offer', () => {
    expect(hetznerLocationWarning('cx23', 'ash')).toMatch(/does not offer cx23 in ash.*cpx21/);
    expect(hetznerLocationWarning('cpx21', 'nbg1')).toMatch(/does not offer/);
    expect(hetznerLocationWarning('cpx22', 'hil')).toMatch(/does not offer/);
    expect(hetznerLocationWarning('cx33', 'fsn1')).toBeNull();
    expect(hetznerLocationWarning('cpx22', 'sin')).toBeNull();
    expect(hetznerLocationWarning('ccx13', 'sin')).toBeNull();
    // An unknown location is not second-guessed.
    expect(hetznerLocationWarning('cx23', 'xyz1')).toBeNull();
  });
});
