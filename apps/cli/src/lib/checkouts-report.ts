/**
 * Report this machine's checkouts to the configured hub's registry
 * (`PUT /api/v1/checkouts`, docs/box-sources-plan.md §4). The folders are on
 * this disk, so only this machine can say they exist, under which repo key
 * (its own ssh aliases expanded) and which of its earlier rows are gone.
 */
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { getMachineLabel, tryGetMachineId } from '@agentbox/config';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { repoKeyAtEdge } from '@agentbox/sandbox-core';
import type { HubApiClient, HubApiCheckoutReport } from '../control-plane/hub-api-client.js';

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
  const entries: HubApiCheckoutReport['entries'] = [];
  for (const raw of folders) {
    const folder = await realpath(raw).catch(() => raw);
    const key = await repoKeyAtEdge(await readGitOriginUrl(folder).catch(() => undefined));
    if (key) entries.push({ repoKey: key, folder });
  }
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
