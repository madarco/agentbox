import 'server-only';

import type { HubState } from './types';

// Thin Next-side wrapper. The real work lives in the Node-only backend the
// custom server sets on globalThis (lib/hub-backend.ts), so Next never imports
// the sandbox/relay toolchain.
export async function getDashboardData(): Promise<HubState> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) {
    // No custom server (e.g. plain `next start`) — nothing to read.
    return { user: { login: 'user', name: 'user' }, github: { available: false, installed: false, appName: 'GitHub App', account: '', installedAt: 0, repos: [] }, projects: [], boxes: [] };
  }
  return backend.getData();
}
