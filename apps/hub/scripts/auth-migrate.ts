/**
 * One-shot auth migration + admin seed for the vercel (Postgres) profile.
 *
 * Serverless can't cheaply migrate at cold start, so run this at deploy time:
 *   AGENTBOX_HUB_PROFILE=vercel POSTGRES_URL=... BETTER_AUTH_SECRET=... \
 *   AGENTBOX_HUB_ADMIN_EMAIL=... AGENTBOX_HUB_ADMIN_PASSWORD=... \
 *   pnpm --filter @agentbox/hub db:auth-migrate
 *
 * The embedded profiles (localhost/hetzner) do this at boot in server.ts.
 */
export {};

process.env.AGENTBOX_HUB_PROFILE ??= 'vercel';

const { authEnabled } = await import('../lib/auth-config');
if (!authEnabled()) {
  // No BETTER_AUTH_SECRET (and no explicit AGENTBOX_HUB_AUTH=on) → auth is off;
  // skip so a secretless build never touches the database.
  process.stdout.write('agentbox-hub: auth disabled — skipping migrate\n');
  process.exit(0);
}

const { ensureAuthReady } = await import('../lib/auth');
await ensureAuthReady();
process.stdout.write('agentbox-hub: auth migrate + seed complete\n');
