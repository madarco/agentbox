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
  // `us-east-1` — the only region with VM runners — is dedicated and handed out
  // by invitation, so a linux-vm default is one most accounts cannot bake at all.
  it('defaults to container, the class every account can run', () => {
    expect(resolveDaytonaClass(cfg({}))).toBe('container');
  });

  it('honors an explicit linux-vm choice', () => {
    expect(resolveDaytonaClass(cfg({ daytonaClass: 'linux-vm' }))).toBe('linux-vm');
  });

  it('degrades any other value to container rather than passing junk to the SDK', () => {
    expect(resolveDaytonaClass(cfg({ daytonaClass: 'windows' }))).toBe('container');
  });
});

describe('resolveDaytonaRegion', () => {
  it('derives us-east-1 for linux-vm — the only region with VM runners', () => {
    expect(resolveDaytonaRegion(cfg({ daytonaClass: 'linux-vm' }))).toBe(DAYTONA_VM_REGION);
  });

  it('leaves the default (container) on the account default region', () => {
    expect(resolveDaytonaRegion(cfg({}))).toBe('');
  });

  it('lets an explicit region win over the class-derived one', () => {
    // So a user can follow Daytona to a second VM region without a release.
    expect(resolveDaytonaRegion(cfg({ daytonaRegion: 'eu-west-9' }))).toBe('eu-west-9');
  });

  it('lets an explicit region win for container too', () => {
    expect(resolveDaytonaRegion(cfg({ daytonaClass: 'container', daytonaRegion: 'eu' }))).toBe(
      'eu',
    );
  });

  it('ignores whitespace-only region', () => {
    expect(resolveDaytonaRegion(cfg({ daytonaClass: 'linux-vm', daytonaRegion: '   ' }))).toBe(
      DAYTONA_VM_REGION,
    );
  });
});
