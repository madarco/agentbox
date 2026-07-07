import { describe, expect, it } from 'vitest';
import { decideTrayUpdate, parseSidecarSha } from '../src/commands/install-tray.js';

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
