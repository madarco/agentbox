import { describe, expect, it } from 'vitest';
import { BUILT_IN_DEFAULTS } from '../src/types.js';
import { DAYTONA_VM_REGION, resolveDaytonaClass, resolveDaytonaRegion } from '../src/daytona.js';
import type { EffectiveConfig } from '../src/types.js';

/** A minimal EffectiveConfig with only the box keys under test overridden. */
function cfg(box: Partial<EffectiveConfig['box']>): EffectiveConfig {
  return {
    ...BUILT_IN_DEFAULTS,
    box: { ...BUILT_IN_DEFAULTS.box, ...box },
  } as EffectiveConfig;
}

describe('resolveDaytonaClass', () => {
  it('defaults to linux-vm', () => {
    expect(resolveDaytonaClass(cfg({}))).toBe('linux-vm');
  });

  it('honors an explicit container choice', () => {
    expect(resolveDaytonaClass(cfg({ daytonaClass: 'container' }))).toBe('container');
  });

  it('treats any other value as linux-vm rather than passing junk to the SDK', () => {
    expect(resolveDaytonaClass(cfg({ daytonaClass: 'windows' }))).toBe('linux-vm');
  });
});

describe('resolveDaytonaRegion', () => {
  it('derives us-east-1 for linux-vm — the only region with VM runners', () => {
    expect(resolveDaytonaRegion(cfg({}))).toBe(DAYTONA_VM_REGION);
  });

  it('leaves container boxes on the account default region (unchanged behavior)', () => {
    expect(resolveDaytonaRegion(cfg({ daytonaClass: 'container' }))).toBe('');
  });

  it('lets an explicit region win over the class-derived one', () => {
    // So a user can follow Daytona to a second VM region without a release.
    expect(resolveDaytonaRegion(cfg({ daytonaRegion: 'eu-west-9' }))).toBe('eu-west-9');
  });

  it('lets an explicit region win for container too', () => {
    expect(resolveDaytonaRegion(cfg({ daytonaClass: 'container', daytonaRegion: 'eu' }))).toBe('eu');
  });

  it('ignores whitespace-only region', () => {
    expect(resolveDaytonaRegion(cfg({ daytonaRegion: '   ' }))).toBe(DAYTONA_VM_REGION);
  });
});
