import { describe, expect, it } from 'vitest';
import { sizeAfterLocationChange, sizeChoicesFor } from '../lib/boxes/region-sizes';

// The shape GET /api/v1/providers serves for hetzner.
const HETZNER = {
  sizes: [
    { key: 'cx23', label: 'cx23' },
    { key: 'cx33', label: 'cx33' },
  ],
  regions: [
    { key: 'nbg1', label: 'nbg1' },
    {
      key: 'ash',
      label: 'ash',
      sizes: [
        { key: 'cpx21', label: 'cpx21 (default here)' },
        { key: 'cpx31', label: 'cpx31' },
      ],
    },
  ],
};

describe('sizeChoicesFor (the create dialog Size list)', () => {
  it('offers the provider sizes where the region declares none, and with no location', () => {
    expect(sizeChoicesFor(HETZNER, 'nbg1')).toEqual({ choices: HETZNER.sizes });
    expect(sizeChoicesFor(HETZNER, '')).toEqual({ choices: HETZNER.sizes });
  });

  it("offers the region's own sizes there, first as its default", () => {
    const { choices, regionDefault } = sizeChoicesFor(HETZNER, 'ASH');
    expect(choices.map((c) => c.key)).toEqual(['cpx21', 'cpx31']);
    expect(regionDefault).toBe('cpx21');
  });

  it('is empty without a provider', () => {
    expect(sizeChoicesFor(undefined, 'ash')).toEqual({ choices: [] });
  });
});

describe('sizeAfterLocationChange', () => {
  const ash = sizeChoicesFor(HETZNER, 'ash').choices;
  it('drops a size the new location does not list, keeping default and custom', () => {
    expect(sizeAfterLocationChange('cx33', ash, '__custom__')).toBe('');
    expect(sizeAfterLocationChange('cpx31', ash, '__custom__')).toBe('cpx31');
    expect(sizeAfterLocationChange('', ash, '__custom__')).toBe('');
    expect(sizeAfterLocationChange('__custom__', ash, '__custom__')).toBe('__custom__');
  });
});
