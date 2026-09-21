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

const { authMode } = await import('../lib/auth-config');
const mode = authMode();
if (mode === 'off') {
  // Auth explicitly disabled (AGENTBOX_HUB_AUTH=off) — skip so a secretless build
  // never touches the database.
  process.stdout.write('agentbox-hub: auth disabled — skipping migrate\n');
  process.exit(0);
}
if (mode === 'locked') {
  // No BETTER_AUTH_SECRET. Fail the deploy here rather than ship a hub that can
  // neither sign a session nor seed its admin — on vercel there is no redeploy
  // command to undo it afterwards.
  process.stderr.write(
    'agentbox-hub: BETTER_AUTH_SECRET is not set — refusing to deploy a hub that cannot authenticate anyone.\n' +
      'Set it in the project env (or set AGENTBOX_HUB_AUTH=off to deploy deliberately without auth).\n',
  );
  process.exit(1);
}

const { ensureAuthReady } = await import('../lib/auth');
await ensureAuthReady();
process.stdout.write('agentbox-hub: auth migrate + seed complete\n');
