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
    if (!connectionString) throw new Error('POSTGRES_URL is required for the vercel hub auth store');
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
    emailAndPassword: { enabled: true },
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
 * and the user does not already exist. Idempotent: the duplicate-user APIError
 * on re-runs is swallowed. Called once at boot (embedded) / at deploy (vercel).
 */
export async function ensureAuthReady(): Promise<void> {
  const auth = await getAuth();
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  const email = process.env.AGENTBOX_HUB_ADMIN_EMAIL;
  const password = process.env.AGENTBOX_HUB_ADMIN_PASSWORD;
  if (!email || !password) return;

  try {
    await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0] || 'admin' } });
  } catch (err) {
    // Already-seeded is the normal steady state; only surface unexpected errors.
    const status = (err as { status?: string; statusCode?: number }).status;
    const code = (err as { statusCode?: number }).statusCode;
    if (status !== 'UNPROCESSABLE_ENTITY' && code !== 422) throw err;
  }
}
