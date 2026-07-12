import { describe, expect, it } from 'vitest';
import {
  decideTrayUpdate,
  parseSidecarSha,
  parseVersionManifest,
  shouldPromptTrayUpdate,
} from '../src/commands/install-app.js';
import { mergeRemoteCheck } from '../src/lib/update-check.js';

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

describe('shouldPromptTrayUpdate', () => {
  // The regression this whole feature exists for: a tray-only release bumps no CLI version, so
  // nothing else in the CLI would ever surface it.
  it('prompts when the published tray differs from the installed one', () => {
    expect(
      shouldPromptTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: SHA_B,
        declinedSha: undefined,
      }),
    ).toBe(true);
  });

  it('stays silent when the app is current', () => {
    expect(
      shouldPromptTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: SHA_A,
        declinedSha: undefined,
      }),
    ).toBe(false);
  });

  it('stays silent when the published sha is unknown (offline / no cache yet)', () => {
    expect(
      shouldPromptTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: undefined,
        declinedSha: undefined,
      }),
    ).toBe(false);
  });

  it('stays silent when the app is not installed', () => {
    expect(
      shouldPromptTrayUpdate({
        installed: false,
        stampedSha: undefined,
        latestSha: SHA_B,
        declinedSha: undefined,
      }),
    ).toBe(false);
  });

  // Anti-nag: without the decline stamp this prompt re-fires on every single command.
  it('does not re-ask about a release the user declined', () => {
    expect(
      shouldPromptTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: SHA_B,
        declinedSha: SHA_B,
      }),
    ).toBe(false);
  });

  it('asks again once a NEWER release lands after a decline', () => {
    const SHA_C = 'c'.repeat(64);
    expect(
      shouldPromptTrayUpdate({
        installed: true,
        stampedSha: SHA_A,
        latestSha: SHA_C,
        declinedSha: SHA_B,
      }),
    ).toBe(true);
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
