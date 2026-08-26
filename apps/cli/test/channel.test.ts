/**
 * Pure-function coverage for the release-channel resolver. Nothing here touches
 * `~/.agentbox` — `channelSetting()`/`persistChannel()` are deliberately left out
 * because they read/WRITE the real global config (GLOBAL_CONFIG_FILE resolves
 * `$HOME` at import time and apps/cli tests have no HOME isolation).
 */

import { describe, expect, it } from 'vitest';
import {
  NIGHTLY_DIST_TAG,
  NIGHTLY_TRAY_TAG,
  STABLE_DIST_TAG,
  STABLE_TRAY_TAG,
  bestOf,
  channelOfVersion,
  effectiveChannel,
  isPrerelease,
  npmDistTags,
  trayReleaseTags,
} from '../src/lib/channel.js';

describe('channelOfVersion', () => {
  it('classifies a nightly build by its prerelease marker', () => {
    expect(channelOfVersion('0.28.0-nightly.202607251430')).toBe('nightly');
    expect(channelOfVersion('0.28.0-nightly.1')).toBe('nightly');
  });

  it('classifies everything else as stable', () => {
    expect(channelOfVersion('0.27.0')).toBe('stable');
    expect(channelOfVersion('0.0.0-dev')).toBe('stable');
    // A non-nightly prerelease is not a nightly channel build.
    expect(channelOfVersion('0.28.0-rc.1')).toBe('stable');
  });
});

describe('isPrerelease', () => {
  it('detects any prerelease suffix, ignoring build metadata', () => {
    expect(isPrerelease('0.28.0-nightly.1')).toBe(true);
    expect(isPrerelease('0.28.0-rc.1')).toBe(true);
    expect(isPrerelease('0.28.0')).toBe(false);
    expect(isPrerelease('0.28.0+build-1')).toBe(false);
  });
});

describe('effectiveChannel', () => {
  it('follows the running build under auto', () => {
    expect(effectiveChannel('auto', '0.28.0-nightly.1')).toBe('nightly');
    expect(effectiveChannel('auto', '0.27.0')).toBe('stable');
  });

  it('lets an explicit setting override the build', () => {
    // The sticky-membership case: a nightly tester now running a plain release
    // must stay on the channel.
    expect(effectiveChannel('nightly', '0.28.0')).toBe('nightly');
    // ...and the opt-out must win even while a nightly build is installed.
    expect(effectiveChannel('stable', '0.28.0-nightly.1')).toBe('stable');
  });
});

describe('dist-tag / release-tag sets', () => {
  it('polls one tag on stable', () => {
    expect(npmDistTags('stable')).toEqual([STABLE_DIST_TAG]);
    expect(trayReleaseTags('stable')).toEqual([STABLE_TRAY_TAG]);
  });

  it('polls both on nightly, so a shipped release can supersede a nightly', () => {
    expect(npmDistTags('nightly')).toEqual([STABLE_DIST_TAG, NIGHTLY_DIST_TAG]);
    expect(trayReleaseTags('nightly')).toEqual([STABLE_TRAY_TAG, NIGHTLY_TRAY_TAG]);
  });
});

describe('bestOf', () => {
  it('picks the stable release once it ships (the crossover case)', () => {
    expect(
      bestOf([
        { tag: 'latest', version: '0.28.0' },
        { tag: 'nightly', version: '0.28.0-nightly.202607251430' },
      ]),
    ).toEqual({ tag: 'latest', version: '0.28.0' });
  });

  it('picks the nightly once it moves past the release', () => {
    expect(
      bestOf([
        { tag: 'latest', version: '0.28.0' },
        { tag: 'nightly', version: '0.29.0-nightly.1' },
      ]),
    ).toEqual({ tag: 'nightly', version: '0.29.0-nightly.1' });
  });

  it('skips candidates that failed to fetch', () => {
    expect(
      bestOf([
        { tag: 'latest', version: undefined },
        { tag: 'nightly', version: '0.29.0-nightly.1' },
      ]),
    ).toEqual({ tag: 'nightly', version: '0.29.0-nightly.1' });
  });

  it('returns null when nothing is available', () => {
    expect(bestOf([])).toBeNull();
    expect(bestOf([{ tag: 'latest', version: undefined }])).toBeNull();
  });

  it('never lets an uncomparable string win by arriving first', () => {
    expect(
      bestOf([
        { tag: 'latest', version: '<!doctype html>' },
        { tag: 'nightly', version: '0.29.0-nightly.1' },
      ]),
    ).toEqual({ tag: 'nightly', version: '0.29.0-nightly.1' });
    expect(bestOf([{ tag: 'latest', version: 'garbage' }])).toBeNull();
  });

  it('keeps the earlier tag on a tie, so a version under both reads as stable', () => {
    expect(
      bestOf([
        { tag: 'latest', version: '0.28.0' },
        { tag: 'nightly', version: '0.28.0' },
      ]),
    ).toEqual({ tag: 'latest', version: '0.28.0' });
  });
});
