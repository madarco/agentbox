/**
 * Hub better-auth server factory (dual dialect).
 *
 * better-auth's built-in Kysely adapter takes the driver instance directly, so
 * there is no drizzle / kysely-adapter / hand-written schema here:
 *   - hetzner/localhost-with-auth → `node:sqlite` `DatabaseSync`
 *   - vercel                      → `pg` `Pool`
 * Boot-time `getMigrations().runMigrations()` creates/upgrades the tables for
 * either dialect.
 *
 * NOTE: intentionally NO `import 'server-only'`. This module is imported by
 * `server.ts` and `scripts/auth-migrate.ts` under plain node/tsx (where the
 * Next-aliased `server-only` module does not resolve). Keep it out of the client
 * bundle by discipline: client code imports `auth.client.ts`, never this file.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { getMigrations } from 'better-auth/db/migration';
import { AUTH_DB_PATH, cookieSecure, hubProfile } from './auth-config';

// better-auth detects the driver instance at runtime, but the option type is a
// narrower union that doesn't literally list DatabaseSync / pg Pool — so cast.
type AuthDatabase = BetterAuthOptions['database'];

async function makeDatabase(): Promise<AuthDatabase> {
  if (hubProfile() === 'vercel') {
    const { Pool } = await import('pg');
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString)
      throw new Error('POSTGRES_URL is required for the vercel hub auth store');
    return new Pool({ connectionString }) as unknown as AuthDatabase;
  }
  // Embedded profiles (hetzner, or localhost with auth explicitly on) → sqlite.
  // Dynamic import keeps `node:sqlite` off the vercel code path entirely.
  const { DatabaseSync } = await import('node:sqlite');
  await mkdir(dirname(AUTH_DB_PATH), { recursive: true });
  return new DatabaseSync(AUTH_DB_PATH) as unknown as AuthDatabase;
}

async function createAuthInstance() {
  const database = await makeDatabase();
  return betterAuth({
    database,
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    // Sign-in only. better-auth's catch-all route serves `/api/auth/sign-up/email`
    // whenever email+password is enabled, and `/api/auth` is necessarily outside
    // the gate's matcher (it is how sign-in works) — so without this flag anyone
    // who can reach a deployed hub can register themselves a full-access account.
    // There is no sign-up UI, which is exactly why it went unnoticed. Accounts are
    // created by the env seed below; `ensureAuthReady` therefore cannot go through
    // the sign-up endpoint either.
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        // http on hetzner would drop a `secure` cookie → login loop; only https (vercel) is secure.
        secure: cookieSecure(),
      },
    },
    // Self-hosted single-origin trust: accept the request's own origin. An
    // operator can pin it by setting BETTER_AUTH_URL (used as baseURL above).
    trustedOrigins: (request) => {
      const origin = request?.headers.get('origin');
      return origin ? [origin] : [];
    },
    plugins: [nextCookies()],
  });
}

let authPromise: ReturnType<typeof createAuthInstance> | undefined;

export function getAuth(): ReturnType<typeof createAuthInstance> {
  authPromise ??= createAuthInstance();
  return authPromise;
}

/**
 * Run migrations, then env-seed a single admin if the credentials are provided
 * and the user does not already exist. Idempotent. Called once at boot (embedded)
 * / at deploy (vercel).
 *
 * The seed goes through the internal adapter rather than `auth.api.signUpEmail`,
 * because sign-up is disabled above and that endpoint now refuses every caller —
 * including this one. These are the same three writes the sign-up route makes
 * (hash, create user, link a `credential` account), so the seeded admin is
 * indistinguishable from a registered one.
 */
export async function ensureAuthReady(): Promise<void> {
  const auth = await getAuth();
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  const email = process.env.AGENTBOX_HUB_ADMIN_EMAIL;
  const password = process.env.AGENTBOX_HUB_ADMIN_PASSWORD;
  if (!email || !password) return;

  const ctx = await auth.$context;
  const normalized = email.toLowerCase();
  // Already seeded is the normal steady state on every boot after the first. Note
  // this never rotates an existing admin's password — changing the env var on a
  // running hub does nothing, by design.
  if ((await ctx.internalAdapter.findUserByEmail(normalized))?.user) return;

  const hash = await ctx.password.hash(password);
  const user = await ctx.internalAdapter.createUser({
    email: normalized,
    name: email.split('@')[0] || 'admin',
    emailVerified: false,
  });
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: hash,
  });
}
