import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostClaudeAccessTokenExpired, hostClaudeLoginDead } from '../src/cli/host-cred-guards.js';

/**
 * Moved here with the guards themselves, out of
 * `sandbox-core/test/credentials-concern.test.ts`. Both only mean anything for a
 * `claude-oauth` blob, and the distinction they encode is load-bearing: a lapsed
 * ACCESS token is normal and renewable, a lapsed REFRESH token is a dead login.
 * Conflating them produced a daily false sign-in nag whose "yes" rotated the
 * shared token away.
 */
describe('claude host-backup guards', () => {
  describe('hostClaudeAccessTokenExpired', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'abx-core-exp-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const write = async (obj: unknown) => {
      const p = join(dir, 'creds.json');
      await writeFile(p, JSON.stringify(obj));
      return p;
    };

    it('true when expiresAt is in the past', async () => {
      const p = await write({ claudeAiOauth: { refreshToken: 'rt', expiresAt: 1000 } });
      expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(true);
    });
    it('false when expiresAt is in the future', async () => {
      const p = await write({ claudeAiOauth: { refreshToken: 'rt', expiresAt: 5000 } });
      expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(false);
    });
    it('false when expiresAt is absent (do not nag)', async () => {
      const p = await write({ claudeAiOauth: { refreshToken: 'rt' } });
      expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(false);
    });
    it('false on a missing/garbage file', async () => {
      expect(await hostClaudeAccessTokenExpired(join(dir, 'nope.json'), 2000)).toBe(false);
    });
  });

  describe('hostClaudeLoginDead', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'abx-core-dead-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const write = async (obj: unknown) => {
      const p = join(dir, 'creds.json');
      await writeFile(p, JSON.stringify(obj));
      return p;
    };

    it('false when the access token lapsed but the refresh token is alive', async () => {
      const p = await write({
        claudeAiOauth: { refreshToken: 'rt', expiresAt: 1000, refreshTokenExpiresAt: 9000 },
      });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(false);
      expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(true);
    });
    it('true when the refresh token itself has expired', async () => {
      const p = await write({
        claudeAiOauth: { refreshToken: 'rt', expiresAt: 5000, refreshTokenExpiresAt: 1000 },
      });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(true);
    });
    it('true when the refresh token is blank (claude blanks it on a rejected refresh)', async () => {
      const p = await write({ claudeAiOauth: { refreshToken: '', refreshTokenExpiresAt: 9000 } });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(true);
    });
    it('false when refreshTokenExpiresAt is absent (never declare death on a guess)', async () => {
      const p = await write({ claudeAiOauth: { refreshToken: 'rt', expiresAt: 1000 } });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(false);
    });
    it('false on a missing file (nothing saved is "missing", not "dead")', async () => {
      expect(await hostClaudeLoginDead(join(dir, 'nope.json'), 2000)).toBe(false);
    });
    it('true on a garbage file that exists', async () => {
      const p = join(dir, 'creds.json');
      await writeFile(p, 'not json');
      expect(await hostClaudeLoginDead(p, 2000)).toBe(true);
    });
  });
});
