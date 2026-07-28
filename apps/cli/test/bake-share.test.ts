import { describe, expect, it } from 'vitest';
import { claudeInstallFingerprint } from '@agentbox/sandbox-core';
import {
  buildRebakeNote,
  buildShareFailedNote,
  classifyBakeShare,
  hasCredentialChanges,
  isShareablePreparedProvider,
  localBakeBlocksAdoption,
  summarizeBakeShare,
} from '../src/control-plane/bake-share.js';
import type { PushDecision } from '../src/control-plane/custody-client.js';

// Pure — no HOME, no network (apps/cli tests have no HOME isolation).

describe('isShareablePreparedProvider', () => {
  it('excludes docker (local image, not a shareable snapshot)', () => {
    expect(isShareablePreparedProvider('docker')).toBe(false);
  });

  it('excludes remote-docker (docker-shaped: its base is a local image on the remote host)', () => {
    expect(isShareablePreparedProvider('remote-docker')).toBe(false);
  });

  it('includes every cloud provider', () => {
    for (const p of ['hetzner', 'digitalocean', 'vercel', 'e2b', 'daytona']) {
      expect(isShareablePreparedProvider(p)).toBe(true);
    }
  });

  it('derives the shareable set from an enumerated provider list, including a plugin provider', () => {
    // The production path enumerates the runtime registry (built-ins AND
    // registered plugins) and filters with this predicate; a fake plugin name
    // like `islo` must survive the filter, not be dropped by a hardcoded list.
    const enumerated = ['docker', 'remote-docker', 'hetzner', 'e2b', 'daytona', 'islo'];
    expect(enumerated.filter(isShareablePreparedProvider)).toEqual([
      'hetzner',
      'e2b',
      'daytona',
      'islo',
    ]);
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
  // A shared base: matches this CLI, same-version hub, upload succeeded.
  const shared = {
    provider: 'hetzner',
    storedFingerprint: nativeFp,
    cliNativeFingerprint: nativeFp,
    hubVersion: CLI_VERSION,
    cliVersion: CLI_VERSION,
    pushSucceeded: true,
  };

  it('reports not-baked when nothing is baked locally', () => {
    expect(
      classifyBakeShare({ ...shared, provider: 'hetzner', storedFingerprint: undefined }),
    ).toEqual({ provider: 'hetzner', status: 'not-baked' });
  });

  it('reports share-failed when the upload did not succeed (no false match)', () => {
    const res = classifyBakeShare({ ...shared, provider: 'vercel', pushSucceeded: false });
    expect(res.status).toBe('share-failed');
    expect(res.reason).toContain('could not upload the vercel bake record');
  });

  it('matches a native-baked record against a same-version hub', () => {
    expect(classifyBakeShare(shared)).toEqual({ provider: 'hetzner', status: 'match' });
  });

  it('matches an npm-baked record (either install mode is accepted)', () => {
    expect(classifyBakeShare({ ...shared, provider: 'e2b', storedFingerprint: npmFp }).status).toBe(
      'match',
    );
  });

  it('flags a record stale vs this CLI build context (different fingerprint)', () => {
    const res = classifyBakeShare({
      ...shared,
      provider: 'vercel',
      storedFingerprint: 'b'.repeat(64),
    });
    expect(res.status).toBe('mismatch');
    expect(res.reason).toContain('agentbox prepare --provider vercel');
  });

  it('flags a version skew even when the local record is current', () => {
    const res = classifyBakeShare({ ...shared, hubVersion: '0.26.0' });
    expect(res.status).toBe('mismatch');
    expect(res.reason).toContain('0.26.0');
    expect(res.reason).toContain(CLI_VERSION);
  });

  it('assumes match when the CLI fingerprint cannot be computed and versions agree', () => {
    expect(
      classifyBakeShare({ ...shared, provider: 'daytona', cliNativeFingerprint: undefined }).status,
    ).toBe('match');
  });

  it('does not flag a skew when the hub version is unknown', () => {
    expect(
      classifyBakeShare({ ...shared, provider: 'daytona', hubVersion: undefined }).status,
    ).toBe('match');
  });

  it('reports adopted when the pull already took the hub record, and warns about nothing', () => {
    // Our own record is stale by definition in that case — the "re-bake this"
    // warning is exactly what adoption exists to silence.
    const res = classifyBakeShare({
      ...shared,
      provider: 'e2b',
      storedFingerprint: 'b'.repeat(64),
      pushSucceeded: false,
      adopted: true,
    });
    expect(res).toEqual({ provider: 'e2b', status: 'adopted' });
    expect(summarizeBakeShare([res])).toMatchObject({ adopted: ['e2b'], mismatched: [] });
  });

  it('a failed push is share-failed even when the fingerprint would have matched', () => {
    // The record never reached the hub, so no fingerprint verdict applies — it
    // must not be reported as either a match or a fingerprint mismatch.
    expect(classifyBakeShare({ ...shared, pushSucceeded: false }).status).toBe('share-failed');
  });
});

describe('summarizeBakeShare + note builders', () => {
  it('splits matched / mismatched / share-failed and builds per-provider notes', () => {
    const results = [
      { provider: 'hetzner', status: 'match' as const },
      {
        provider: 'vercel',
        status: 'mismatch' as const,
        reason: 'the hub runs 0.26.0 but this CLI is 0.27.1',
      },
      {
        provider: 'e2b',
        status: 'share-failed' as const,
        reason: 'could not upload the e2b bake record to the control box',
      },
      { provider: 'daytona', status: 'not-baked' as const },
    ];
    const summary = summarizeBakeShare(results);
    expect(summary.matched).toEqual(['hetzner']);
    expect(summary.mismatched.map((m) => m.provider)).toEqual(['vercel']);
    expect(summary.shareFailed.map((m) => m.provider)).toEqual(['e2b']);

    const rebake = buildRebakeNote(summary.mismatched);
    expect(rebake).toContain('bake them again');
    expect(rebake).toContain('  - vercel: the hub runs 0.26.0');
    expect(rebake).not.toContain('hetzner');

    const failed = buildShareFailedNote(summary.shareFailed);
    expect(failed).toContain('Could not share');
    expect(failed).toContain('e2b');
    expect(failed).toContain('agentbox hub setup');
    // A mismatch is a distinct outcome — it must not leak into the failed note.
    expect(failed).not.toContain('vercel');
  });

  it('note builders return null when their bucket is empty', () => {
    expect(buildRebakeNote([])).toBeNull();
    expect(buildShareFailedNote([])).toBeNull();
  });
});

describe('localBakeBlocksAdoption', () => {
  const LIVE = 'a'.repeat(64);
  const OLD = 'b'.repeat(64);
  const rec = (sha?: string) => ({ base: sha === undefined ? {} : { contextSha256: sha } });

  it('blocks when the local bake already matches this build context', () => {
    expect(localBakeBlocksAdoption(rec(LIVE), LIVE)).toBe(true);
  });

  it('blocks an npm-fold local bake too — the probe is always the native hash', () => {
    // A `box.claudeInstall=npm` machine stores the FOLDED fingerprint. A strict
    // compare called its perfectly current base a miss, so a prepare that found
    // nothing in custody re-baked a base it already had, every time.
    expect(localBakeBlocksAdoption(rec(claudeInstallFingerprint(LIVE, 'npm')), LIVE)).toBe(true);
  });

  // The bug this replaced: an outdated record used to block adoption outright,
  // so the machine that most needed the shared base could never take it.
  it('does NOT block when the local bake is from an older build context', () => {
    expect(localBakeBlocksAdoption(rec(OLD), LIVE)).toBe(false);
  });

  it('does not block when nothing is baked here', () => {
    expect(localBakeBlocksAdoption(null, LIVE)).toBe(false);
  });

  it('does not block on a record with no fingerprint to compare', () => {
    expect(localBakeBlocksAdoption(rec(undefined), LIVE)).toBe(false);
  });
});
