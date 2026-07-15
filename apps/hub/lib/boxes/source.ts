import 'server-only';

import { authMode } from '../auth-config';
import { getPostgresDashboardData, hasPostgresSource } from './postgres-source';
import type { HubState } from './types';

// Thin Next-side wrapper. Box state comes from one of two sources:
//  - the in-process host backend the custom server sets on globalThis (embedded
//    localhost/hetzner `agentbox hub`) — Next never imports the sandbox toolchain;
//  - a Postgres source (the `next start` deploy path, vercel/hetzner-compose),
//    dynamically imported so `pg` stays out of the localhost bundle.
export async function getDashboardData(): Promise<HubState> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (backend) {
    return { ...(await backend.getData()), authMode: authMode() };
  }
  if (hasPostgresSource()) {
    return { ...(await getPostgresDashboardData()), authMode: authMode() };
  }
  // No source (e.g. plain `next start` with no Postgres) — nothing to read.
  return { user: { login: 'user', name: 'user' }, github: { available: false, installed: false, appName: 'GitHub App', account: '', installedAt: 0, repos: [] }, projects: [], boxes: [], approvals: [], providers: [], controlPlane: null, authMode: authMode() };
}
