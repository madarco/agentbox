import { describe, expect, it } from 'vitest';
import {
  decideTrayUpdate,
  parseSidecarSha,
  parseVersionManifest,
} from '../src/commands/install-app.js';
import { mergeRemoteCheck, trayNudgeMessage } from '../src/lib/update-check.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('parseSidecarSha', () => {
  it('parses the shasum sidecar format', () => {
    expect(parseSidecarSha(`${SHA_A}  AgentBox.zip\n`)).toBe(SHA_A);
  });

  it('lowercases the digest', () => {
    expect(parseSidecarSha(`${'A'.repeat(64)}  AgentBox.zip`)).toBe(SHA_A);
  });

  it('accepts a bare digest with no filename', () => {
    expect(parseSidecarSha(`${SHA_A}\n`)).toBe(SHA_A);
  });

  it('rejects non-sha content (error pages, truncated bodies)', () => {
    expect(parseSidecarSha('Not Found')).toBeUndefined();
    expect(parseSidecarSha('')).toBeUndefined();
    expect(parseSidecarSha('deadbeef  AgentBox.zip')).toBeUndefined();
    expect(parseSidecarSha('<html>rate limited</html>')).toBeUndefined();
  });
});

describe('decideTrayUpdate', () => {
  it('never updates when the app is not installed', () => {
    expect(
      decideTrayUpdate({ installed: false, stampedSha: SHA_A, latestSha: SHA_B }),
    ).toEqual({ update: false, reason: 'not-installed' });
  });

  it('never downloads when the published sha is unknown (offline)', () => {
    expect(
      decideTrayUpdate({ installed: true, stampedSha: SHA_A, latestSha: undefined }),
    ).toEqual({ update: false, reason: 'no-latest-sha' });
  });

  it('self-heals a pre-stamp install: missing stamp reads as update-needed', () => {
    expect(
      decideTrayUpdate({ installed: true, stampedSha: undefined, latestSha: SHA_A }),
    ).toEqual({ update: true, reason: 'no-stamp' });
  });

  it('updates on mismatch, skips when current', () => {
    expect(
      decideTrayUpdate({ installed: true, stampedSha: SHA_A, latestSha: SHA_B }),
    ).toEqual({ update: true, reason: 'mismatch' });
    expect(
      decideTrayUpdate({ installed: true, stampedSha: SHA_A, latestSha: SHA_A }),
    ).toEqual({ update: false, reason: 'up-to-date' });
  });
});

describe('parseVersionManifest', () => {
  it('parses the published version', () => {
    expect(parseVersionManifest(`{"version":"0.1.10","zipSha256":"${SHA_A}"}`)).toBe('0.1.10');
  });

  it('returns undefined for a release with no manifest (404 body) or a malformed one', () => {
    expect(parseVersionManifest('Not Found')).toBeUndefined();
    expect(parseVersionManifest('')).toBeUndefined();
    expect(parseVersionManifest('{"version":""}')).toBeUndefined();
    expect(parseVersionManifest('{"version":42}')).toBeUndefined();
    expect(parseVersionManifest('{}')).toBeUndefined();
  });
});

describe('mergeRemoteCheck', () => {
  const prev = {
    checkedAt: '2026-07-11T00:00:00.000Z',
    npmLatest: '0.24.0',
    trayLatestSha: SHA_A,
    trayLatestVersion: '0.1.9',
  };

  it('keeps the cached value when a fetch failed but nothing moved', () => {
    expect(mergeRemoteCheck({ trayLatestSha: SHA_A }, prev)).toEqual({
      npmLatest: '0.24.0',
      trayLatestSha: SHA_A,
      trayLatestVersion: '0.1.9',
    });
  });

  // The sha and the version describe the SAME release. Inheriting the old version next to a fresh
  // sha would name the previous release in the prompt while installing the new one.
  it('drops a stale version when the sha moved but the manifest did not come back', () => {
    const merged = mergeRemoteCheck({ trayLatestSha: SHA_B }, prev);
    expect(merged.trayLatestSha).toBe(SHA_B);
    expect(merged.trayLatestVersion).toBeUndefined();
  });

  it('pairs a fresh sha with its fresh version', () => {
    const merged = mergeRemoteCheck({ trayLatestSha: SHA_B, trayLatestVersion: '0.1.10' }, prev);
    expect(merged.trayLatestSha).toBe(SHA_B);
    expect(merged.trayLatestVersion).toBe('0.1.10');
  });

  it('falls back to the whole cached entry when every fetch failed (offline)', () => {
    expect(mergeRemoteCheck({}, prev)).toEqual({
      npmLatest: '0.24.0',
      trayLatestSha: SHA_A,
      trayLatestVersion: '0.1.9',
    });
  });

  it('is empty on a first-ever probe that fetched nothing', () => {
    expect(mergeRemoteCheck({}, undefined)).toEqual({});
  });
});

describe('decideTrayUpdate — version beats the sha stamp', () => {
  // The false positive: the app was installed by dragging the DMG (or by a CLI
  // that predated sha stamping), so there is no stamp — and the old sha-only
  // logic reported "update available" forever, even on the newest app.
  it('does NOT claim an update when the installed app is already the published one', () => {
    expect(
      decideTrayUpdate({
        installed: true,
        stampedSha: undefined, // never installed by this CLI
        latestSha: SHA_B,
        installedVersion: '0.1.12',
        latestVersion: '0.1.12',
      }),
    ).toEqual({ update: false, reason: 'up-to-date' });
  });

  it('claims an update when the installed app is genuinely older', () => {
    expect(
      decideTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: SHA_B,
        installedVersion: '0.1.11',
        latestVersion: '0.1.12',
      }),
    ).toEqual({ update: true, reason: 'older-version' });
  });

  // A stale stamp must not override the versions: a reinstall of the same build
  // changes the zip sha, but the app is still current.
  it('trusts the versions over a mismatched stamp', () => {
    expect(
      decideTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: SHA_B,
        installedVersion: '0.1.12',
        latestVersion: '0.1.12',
      }),
    ).toEqual({ update: false, reason: 'up-to-date' });
  });

  it('falls back to the sha when a version is unreadable', () => {
    expect(
      decideTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: SHA_B,
        installedVersion: undefined,
        latestVersion: '0.1.12',
      }),
    ).toEqual({ update: true, reason: 'mismatch' });
  });
});

describe('trayNudgeMessage', () => {
  const st = (v?: string) => ({
    version: 1 as const,
    remoteCheck: { checkedAt: '2026-07-12T00:00:00.000Z', trayLatestVersion: v },
  });

  it('is silent when the installed app is current', () => {
    expect(trayNudgeMessage(st('0.1.12'), '0.1.12')).toBeNull();
  });

  it('names both versions when behind', () => {
    expect(trayNudgeMessage(st('0.1.12'), '0.1.11')).toContain('0.1.12');
    expect(trayNudgeMessage(st('0.1.12'), '0.1.11')).toContain('agentbox install app');
  });

  it('is silent when either version is unknown', () => {
    expect(trayNudgeMessage(st(undefined), '0.1.11')).toBeNull();
    expect(trayNudgeMessage(st('0.1.12'), undefined)).toBeNull();
  });
});
