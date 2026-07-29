import 'server-only';

import { authMode } from '../auth-config';
import { getPostgresDashboardData, hasPostgresSource } from './postgres-source';
import type { HubState } from './types';

// Thin Next-side wrapper. Box state comes from one of two sources:
//  - the in-process host backend the custom server sets on globalThis (embedded
//    localhost/hetzner `agentbox hub`) — Next never imports the sandbox toolchain;
//  - a Postgres source (the `next start` deploy path, vercel/hetzner-compose),
//    dynamically imported so `pg` stays out of the localhost bundle.
export async function getDashboardData(opts?: { live?: boolean }): Promise<HubState> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (backend) {
    return { ...(await backend.getData(opts)), authMode: authMode() };
  }
  // The Postgres/plane path is a read-only DB view with no provider SDK to
  // probe, so `live` is silently a no-op there (same as `?freshness=1`).
  if (hasPostgresSource()) {
    return { ...(await getPostgresDashboardData()), authMode: authMode() };
  }
  // No source (e.g. plain `next start` with no Postgres) — nothing to read.
  return { user: { login: 'user', name: 'user' }, github: { available: false, installed: false, appName: 'GitHub App', account: '', installedAt: 0, repos: [] }, projects: [], boxes: [], approvals: [], providers: [], controlPlane: null, authMode: authMode() };
}
