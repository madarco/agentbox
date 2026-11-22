/**
 * Report this machine's checkouts to the configured hub's registry
 * (`PUT /api/v1/checkouts`, docs/box-sources-plan.md §4). The folders are on
 * this disk, so only this machine can say they exist, under which repo key
 * (its own ssh aliases expanded) and which of its earlier rows are gone.
 */
import { existsSync } from 'node:fs';
import { getMachineLabel, tryGetMachineId } from '@agentbox/config';
import { checkoutEntriesFor } from '@agentbox/sandbox-core';
import type { HubApiClient, HubApiCheckoutReport } from '../control-plane/hub-api-client.js';
import { withHubClientQuiet } from '../control-plane/with-hub.js';
import { workspaceHub } from './workspace-ref.js';

/**
 * Build the report for `folders`, plus removals for any of this machine's
 * registered rows whose folder no longer exists. Null without a machine id:
 * the hub refuses such a report, and a hostname vouches for nothing.
 */
export async function buildCheckoutReport(
  folders: readonly string[],
  registered: readonly { repoKey: string; folder: string }[] = [],
): Promise<HubApiCheckoutReport | null> {
  const machineId = tryGetMachineId();
  if (!machineId) return null;
  const entries: HubApiCheckoutReport['entries'] = await checkoutEntriesFor(folders);
  const removed = registered
    .filter((r) => !existsSync(r.folder))
    .map((r) => ({ repoKey: r.repoKey, folder: r.folder }));
  if (entries.length === 0 && removed.length === 0) return null;
  return {
    machineId,
    label: getMachineLabel(),
    entries,
    ...(removed.length > 0 ? { removed } : {}),
  };
}

/** Report `folders` (and prune this machine's vanished rows) on `client`'s hub. */
export async function reportCheckouts(
  client: HubApiClient,
  folders: readonly string[],
): Promise<void> {
  const machineId = tryGetMachineId();
  if (!machineId) return;
  const registered = await client.listCheckouts({ machineId }).catch(() => []);
  const report = await buildCheckoutReport(folders, registered);
  if (report) await client.reportCheckouts(report);
}

/**
 * Tell the configured hub (the store hub, as for workspaces) that this machine
 * has `folders` checked out. Every create entry point calls this
 * (`agentbox create` and the agent commands): it is the registry another PC's
 * box may be routed to later. Bookkeeping, so quiet, and not awaited on the
 * create's critical path.
 */
export function reportCheckoutInBackground(...folders: string[]): void {
  void withHubClientQuiet(workspaceHub(), (client) => reportCheckouts(client, folders));
}
