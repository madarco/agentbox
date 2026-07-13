import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAwsCredentials, restoreManagedEnv, snapshotManagedEnv } from '../src/credentials.js';
import { resetAwsEnvLoadedForTests } from '../src/env-loader.js';

/**
 * The headless gate. `ensureAwsCredentials` is reached through the one generic
 * `getProvider()` seam, and the callers that matter are NOT terminals: the hub
 * (a Next server), the detached queued `-i` worker, CI, and any piped run.
 * Returning silently there — what it used to do — just deferred the failure to
 * a raw `CredentialsProviderError` from deep inside the SDK, twenty seconds
 * later, with no hint about what to do.
 *
 * HOME is redirected to an empty tmpdir so the real `~/.agentbox/secrets.env`
 * (which on a developer machine DOES have credentials) can't decide the test.
 */
let home: string;
let envSnapshot: Record<string, string | undefined>;
let realHome: string | undefined;
let realIsTty: boolean | undefined;

beforeEach(async () => {
  envSnapshot = snapshotManagedEnv();
  realHome = process.env.HOME;
  realIsTty = process.stdin.isTTY;
  home = await mkdtemp(join(tmpdir(), 'aws-creds-'));
  process.env.HOME = home;
  for (const k of ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const) {
    delete process.env[k];
  }
  resetAwsEnvLoadedForTests();
});

afterEach(() => {
  restoreManagedEnv(envSnapshot);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  Object.defineProperty(process.stdin, 'isTTY', { value: realIsTty, configurable: true });
  resetAwsEnvLoadedForTests();
});

function setTty(isTty: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTty, configurable: true });
}

describe('ensureAwsCredentials in a headless context', () => {
  it('throws an actionable NotAuthenticatedError instead of returning silently', async () => {
    setTty(false);
    await expect(ensureAwsCredentials()).rejects.toMatchObject({
      name: 'NotAuthenticatedError',
      provider: 'aws',
    });
  });

  it('names the fix — a raw SDK CredentialsProviderError is what we are replacing', async () => {
    setTty(false);
    await expect(ensureAwsCredentials()).rejects.toThrow(/agentbox aws login/);
    // And it says why it can't just ask.
    await expect(ensureAwsCredentials()).rejects.toThrow(/cannot prompt/i);
  });

  it('stays quiet when credentials ARE configured (the gate must not fire on the happy path)', async () => {
    setTty(false);
    process.env.AWS_PROFILE = 'some-profile';
    await expect(ensureAwsCredentials()).resolves.toBeUndefined();
  });

  it('a static key pair also satisfies the gate', async () => {
    setTty(false);
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    await expect(ensureAwsCredentials()).resolves.toBeUndefined();
  });
});
