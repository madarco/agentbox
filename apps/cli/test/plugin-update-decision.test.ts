import { describe, expect, it } from 'vitest';
import {
  decidePluginUpdates,
  majorsFromRange,
  publishApiVersion,
  type PluginUpdateCandidate,
  type PublishedPluginVersion,
} from '../src/lib/plugin-update-decision.js';

const cand = (over: Partial<PluginUpdateCandidate> = {}): PluginUpdateCandidate => ({
  packageName: 'agentbox-provider-x',
  installedVersion: '1.0.0',
  installedApiVersion: 4,
  install: { kind: 'npm' },
  published: [{ version: '1.0.0', providerApiVersion: 4 }],
  ...over,
});

const decide = (over: Partial<PluginUpdateCandidate> = {}, supported: number[] = [4]) =>
  decidePluginUpdates({ candidates: [cand(over)], supportedMajors: supported, skipFlag: false })[0];

describe('decidePluginUpdates', () => {
  it('moves to a newer compatible release', () => {
    const out = decide({
      published: [
        { version: '1.0.0', providerApiVersion: 4 },
        { version: '1.1.0', providerApiVersion: 4 },
      ],
    });
    expect(out).toMatchObject({
      action: 'update',
      from: '1.0.0',
      to: '1.1.0',
      reason: 'newer',
      manager: 'npm',
    });
  });

  it('leaves the newest compatible release alone', () => {
    expect(decide()).toMatchObject({ action: 'already-newest', version: '1.0.0' });
  });

  // The case that prompted this feature: tenki publishes only SDK v2 builds.
  it('leaves tenki in place when nothing published targets v4', () => {
    const out = decide(
      {
        packageName: '@tenkicloud/agentbox-provider',
        installedVersion: '0.1.1',
        installedApiVersion: 2,
        published: [
          { version: '0.1.0', providerApiVersion: 2, sdkRange: '^2' },
          { version: '0.1.1', providerApiVersion: 2, sdkRange: '^2' },
        ],
      },
      [4],
    );
    expect(out).toMatchObject({
      action: 'no-compatible-version',
      reason: 'all-incompatible',
      installedVersion: '0.1.1',
      newestPublished: '0.1.1',
    });
  });

  // The regression that proves this is not a blind `@latest`.
  it('picks the newest version THIS gate supports, not the newest published', () => {
    const out = decide(
      {
        installedVersion: '0.1.0',
        installedApiVersion: 2,
        published: [
          { version: '0.1.0', providerApiVersion: 2 },
          { version: '0.1.1', providerApiVersion: 2 },
          { version: '0.2.0', providerApiVersion: 4 },
        ],
      },
      [1, 2],
    );
    expect(out).toMatchObject({ action: 'update', to: '0.1.1' });
  });

  it('trusts providerApiVersion over a disagreeing sdk range', () => {
    const out = decide({
      published: [
        { version: '1.0.0', providerApiVersion: 4 },
        { version: '2.0.0', providerApiVersion: 9, sdkRange: '^4' },
      ],
    });
    expect(out).toMatchObject({ action: 'already-newest' });
  });

  it('falls back to the sdk range when providerApiVersion is absent', () => {
    const out = decide({
      published: [
        { version: '1.0.0', providerApiVersion: 4 },
        { version: '1.2.0', sdkRange: '^4' },
      ],
    });
    expect(out).toMatchObject({ action: 'update', to: '1.2.0', source: 'sdk-range' });
  });

  it('refuses a release carrying neither signal', () => {
    const out = decide({
      installedVersion: '0.9.0',
      installedApiVersion: 2,
      published: [{ version: '1.0.0' }],
    });
    expect(out).toMatchObject({
      action: 'no-compatible-version',
      reason: 'no-api-version-metadata',
    });
  });

  it('never installs a deprecated release', () => {
    const out = decide({
      published: [
        { version: '1.0.0', providerApiVersion: 4 },
        { version: '1.1.0', providerApiVersion: 4, deprecated: true },
      ],
    });
    expect(out).toMatchObject({ action: 'already-newest' });
  });

  it('does not move a release user onto a prerelease', () => {
    const out = decide({
      published: [
        { version: '1.0.0', providerApiVersion: 4 },
        { version: '1.1.0-beta.1', providerApiVersion: 4 },
      ],
    });
    expect(out).toMatchObject({ action: 'already-newest' });
  });

  it('offers a prerelease to someone already running one', () => {
    const out = decide({
      installedVersion: '1.1.0-beta.1',
      published: [
        { version: '1.1.0-beta.1', providerApiVersion: 4 },
        { version: '1.1.0-beta.2', providerApiVersion: 4 },
      ],
    });
    expect(out).toMatchObject({ action: 'update', to: '1.1.0-beta.2' });
  });

  it('walks an unsupported plugin BACK to a compatible release', () => {
    const out = decide(
      {
        installedVersion: '2.0.0',
        installedApiVersion: 5,
        published: [
          { version: '1.0.0', providerApiVersion: 4 },
          { version: '2.0.0', providerApiVersion: 5 },
        ],
      },
      [4],
    );
    expect(out).toMatchObject({ action: 'update', to: '1.0.0', reason: 'downgrade-to-compatible' });
  });

  it('never walks a WORKING plugin backwards', () => {
    const out = decide({
      installedVersion: '2.0.0',
      installedApiVersion: 4,
      published: [
        { version: '1.0.0', providerApiVersion: 4 },
        { version: '2.0.0', providerApiVersion: 4 },
      ],
    });
    expect(out).toMatchObject({ action: 'already-newest' });
  });

  it.each(['path', 'linked'] as const)(
    'skips a %s install without consulting the registry',
    (kind) => {
      const out = decide({ install: { kind }, published: undefined });
      expect(out).toMatchObject({ action: 'skipped-path', reason: kind });
    },
  );

  it('reports an unresolvable package as missing, not as a path install', () => {
    expect(decide({ install: { kind: 'missing' } })).toMatchObject({ action: 'skipped-missing' });
  });

  // A 404 and a dead network send the user to completely different places.
  it('distinguishes "registry has no such package" from "cannot reach registry"', () => {
    expect(decide({ published: [] })).toMatchObject({
      action: 'no-compatible-version',
      reason: 'not-published',
    });
    expect(decide({ published: undefined })).toMatchObject({
      action: 'unknown',
      reason: 'offline',
    });
  });

  it('leaves everything alone when the registry is unreachable', () => {
    expect(decide({ published: undefined })).toMatchObject({
      action: 'unknown',
      reason: 'offline',
    });
  });

  it('honours the skip flag for every candidate', () => {
    const outs = decidePluginUpdates({
      candidates: [cand(), cand({ packageName: 'b' })],
      supportedMajors: [4],
      skipFlag: true,
    });
    expect(outs.every((o) => o.action === 'skipped-flag')).toBe(true);
  });

  it('does not let one offline package suppress another that can update', () => {
    const outs = decidePluginUpdates({
      candidates: [
        cand({ packageName: 'offline', published: undefined }),
        cand({
          packageName: 'movable',
          published: [
            { version: '1.0.0', providerApiVersion: 4 },
            { version: '1.1.0', providerApiVersion: 4 },
          ],
        }),
      ],
      supportedMajors: [4],
      skipFlag: false,
    });
    expect(outs.map((o) => o.action)).toEqual(['unknown', 'update']);
  });

  it('routes a pnpm-global install through pnpm', () => {
    const out = decide({
      install: { kind: 'pnpm' },
      published: [
        { version: '1.0.0', providerApiVersion: 4 },
        { version: '1.1.0', providerApiVersion: 4 },
      ],
    });
    expect(out).toMatchObject({ action: 'update', manager: 'pnpm' });
  });
});

describe('majorsFromRange', () => {
  it.each([
    ['^2', [2]],
    ['^2.1.0', [2]],
    ['^2.4.0', [2]],
    ['~4.1', [4]],
    ['4.x', [4]],
    ['4', [4]],
    ['=4.0.0', [4]],
    ['v4.1.0', [4]],
    ['2 || 3', [2, 3]],
  ])('%s -> %j', (range, expected) => {
    expect(majorsFromRange(range)).toEqual(expected);
  });

  // The one mistake here that would silently install an unsupported major.
  it('treats < as an exclusive upper bound, not a candidate', () => {
    expect(majorsFromRange('>=4 <5')).toEqual([4]);
    expect(majorsFromRange('>=4.0.0-rc.1 <5')).toEqual([4]);
  });

  it.each([
    '*',
    'x',
    '',
    '   ',
    'workspace:*',
    'file:../x',
    'link:../x',
    'github:u/r',
    'https://x/y.tgz',
  ])('gives up on %s rather than guessing', (range) => {
    expect(majorsFromRange(range)).toBeNull();
  });
});

describe('publishApiVersion', () => {
  it('marks a declared version incompatible when the gate disagrees', () => {
    const v: PublishedPluginVersion = { version: '1.0.0', providerApiVersion: 2 };
    expect(publishApiVersion(v, [4])).toEqual({
      apiVersion: 2,
      source: 'declared',
      compatible: false,
    });
  });

  it('reports no signal at all as source "none"', () => {
    expect(publishApiVersion({ version: '1.0.0' }, [4])).toEqual({
      apiVersion: null,
      source: 'none',
      compatible: false,
    });
  });
});
