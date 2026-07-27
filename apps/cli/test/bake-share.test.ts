import { describe, expect, it } from 'vitest';
import { claudeInstallFingerprint } from '@agentbox/sandbox-core';
import {
  SHAREABLE_PREPARED_PROVIDERS,
  buildRebakeNote,
  classifyBakeShare,
  hasCredentialChanges,
  isShareablePreparedProvider,
  summarizeBakeShare,
} from '../src/control-plane/bake-share.js';
import type { PushDecision } from '../src/control-plane/custody-client.js';

// Pure — no HOME, no network (apps/cli tests have no HOME isolation).

describe('isShareablePreparedProvider', () => {
  it('excludes docker (local image, not a shareable snapshot)', () => {
    expect(isShareablePreparedProvider('docker')).toBe(false);
  });

  it('includes every cloud provider in the enumerated list', () => {
    for (const p of SHAREABLE_PREPARED_PROVIDERS) {
      expect(isShareablePreparedProvider(p)).toBe(true);
    }
    expect(SHAREABLE_PREPARED_PROVIDERS).not.toContain('docker' as never);
    expect(SHAREABLE_PREPARED_PROVIDERS).toContain('hetzner');
    expect(SHAREABLE_PREPARED_PROVIDERS).toContain('digitalocean');
  });
});

describe('hasCredentialChanges (change-detection predicate)', () => {
  const decision = (action: PushDecision['action']): PushDecision => ({
    path: 'agents/claude/.credentials.json',
    action,
    reason: action,
  });

  it('is false when every item is a hash-skip', () => {
    expect(hasCredentialChanges([decision('skip'), decision('skip')])).toBe(false);
  });

  it('is true when any item is due for upload', () => {
    expect(hasCredentialChanges([decision('skip'), decision('upload')])).toBe(true);
  });

  it('is false for an empty plan', () => {
    expect(hasCredentialChanges([])).toBe(false);
  });
});

describe('classifyBakeShare', () => {
  const CLI_VERSION = '0.27.1';
  const nativeFp = 'a'.repeat(64);
  const npmFp = claudeInstallFingerprint(nativeFp, 'npm');

  it('reports not-baked when nothing is baked locally', () => {
    expect(
      classifyBakeShare({
        provider: 'hetzner',
        storedFingerprint: undefined,
        cliNativeFingerprint: nativeFp,
        hubVersion: CLI_VERSION,
        cliVersion: CLI_VERSION,
      }),
    ).toEqual({ provider: 'hetzner', status: 'not-baked' });
  });

  it('matches a native-baked record against a same-version hub', () => {
    expect(
      classifyBakeShare({
        provider: 'hetzner',
        storedFingerprint: nativeFp,
        cliNativeFingerprint: nativeFp,
        hubVersion: CLI_VERSION,
        cliVersion: CLI_VERSION,
      }),
    ).toEqual({ provider: 'hetzner', status: 'match' });
  });

  it('matches an npm-baked record (either install mode is accepted)', () => {
    expect(
      classifyBakeShare({
        provider: 'e2b',
        storedFingerprint: npmFp,
        cliNativeFingerprint: nativeFp,
        hubVersion: CLI_VERSION,
        cliVersion: CLI_VERSION,
      }).status,
    ).toBe('match');
  });

  it('flags a record stale vs this CLI build context (different fingerprint)', () => {
    const res = classifyBakeShare({
      provider: 'vercel',
      storedFingerprint: 'b'.repeat(64),
      cliNativeFingerprint: nativeFp,
      hubVersion: CLI_VERSION,
      cliVersion: CLI_VERSION,
    });
    expect(res.status).toBe('mismatch');
    expect(res.reason).toContain('agentbox prepare --provider vercel');
  });

  it('flags a version skew even when the local record is current', () => {
    const res = classifyBakeShare({
      provider: 'hetzner',
      storedFingerprint: nativeFp,
      cliNativeFingerprint: nativeFp,
      hubVersion: '0.26.0',
      cliVersion: CLI_VERSION,
    });
    expect(res.status).toBe('mismatch');
    expect(res.reason).toContain('0.26.0');
    expect(res.reason).toContain(CLI_VERSION);
  });

  it('assumes match when the CLI fingerprint cannot be computed and versions agree', () => {
    expect(
      classifyBakeShare({
        provider: 'daytona',
        storedFingerprint: nativeFp,
        cliNativeFingerprint: undefined,
        hubVersion: CLI_VERSION,
        cliVersion: CLI_VERSION,
      }).status,
    ).toBe('match');
  });

  it('does not flag a skew when the hub version is unknown', () => {
    expect(
      classifyBakeShare({
        provider: 'daytona',
        storedFingerprint: nativeFp,
        cliNativeFingerprint: nativeFp,
        hubVersion: undefined,
        cliVersion: CLI_VERSION,
      }).status,
    ).toBe('match');
  });
});

describe('summarizeBakeShare + buildRebakeNote', () => {
  it('splits matched from mismatched and builds a per-provider note', () => {
    const results = [
      { provider: 'hetzner', status: 'match' as const },
      {
        provider: 'vercel',
        status: 'mismatch' as const,
        reason: 'the hub runs 0.26.0 but this CLI is 0.27.1',
      },
      { provider: 'e2b', status: 'not-baked' as const },
    ];
    const summary = summarizeBakeShare(results);
    expect(summary.matched).toEqual(['hetzner']);
    expect(summary.mismatched.map((m) => m.provider)).toEqual(['vercel']);

    const note = buildRebakeNote(summary.mismatched);
    expect(note).toContain('bake them again');
    expect(note).toContain('  - vercel: the hub runs 0.26.0');
    expect(note).not.toContain('hetzner');
  });

  it('returns null when nothing mismatched', () => {
    expect(buildRebakeNote([])).toBeNull();
  });
});
