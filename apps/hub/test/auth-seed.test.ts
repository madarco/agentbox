import { beforeAll, describe, expect, it } from 'vitest';

// The admin seed is the ONLY way an account is created on a hub now that sign-up
// is disabled, and it can no longer go through `auth.api.signUpEmail` (that route
// refuses everyone, including us). This test pins both halves: the seed still
// works against a real database, and the sign-up endpoint is genuinely shut.
//
// Pure by the repo's rule — no docker, no network. `test/setup.ts` gives the file
// its own temp HOME before the static imports evaluate, so `AUTH_DB_PATH` lands
// in the temp dir and this never touches a developer's ~/.agentbox.

const EMAIL = 'admin@example.com';
const PASSWORD = 'seeded-password-123';

process.env.BETTER_AUTH_SECRET = 'test-secret-for-the-seed-0123456789';
process.env.AGENTBOX_HUB_ADMIN_EMAIL = EMAIL;
process.env.AGENTBOX_HUB_ADMIN_PASSWORD = PASSWORD;

const { ensureAuthReady, getAuth } = await import('../lib/auth');

describe('ensureAuthReady (the env admin seed)', () => {
  beforeAll(async () => {
    await ensureAuthReady();
  });

  it('seeds exactly one admin, who can sign in', async () => {
    const auth = await getAuth();
    const res = await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } });
    expect(res.user.email).toBe(EMAIL);
  });

  it('is idempotent — a second boot neither duplicates nor throws', async () => {
    await expect(ensureAuthReady()).resolves.toBeUndefined();
    const auth = await getAuth();
    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail(EMAIL);
    expect(found?.user.email).toBe(EMAIL);
  });

  it('refuses a wrong password (the seeded credential is a real hashed one)', async () => {
    const auth = await getAuth();
    await expect(
      auth.api.signInEmail({ body: { email: EMAIL, password: 'not-the-password' } }),
    ).rejects.toThrow();
  });

  it('THE invariant: the sign-up endpoint creates nobody', async () => {
    // `/api/auth/*` is necessarily outside the gate's matcher, so this endpoint is
    // reachable unauthenticated on every deployed hub. If it ever opens again,
    // anyone who finds the URL owns the control box.
    const auth = await getAuth();
    await expect(
      auth.api.signUpEmail({
        body: { email: 'squatter@example.com', password: 'hunter2hunter2', name: 'sq' },
      }),
    ).rejects.toThrow(/not enabled/i);

    const ctx = await auth.$context;
    expect(await ctx.internalAdapter.findUserByEmail('squatter@example.com')).toBeFalsy();
  });
});
