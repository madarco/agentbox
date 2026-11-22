// The checkouts registry (docs/box-sources-plan.md §4): "machine M has repo R at
// folder F", keyed by machine id and repo key. PCs report their own folders
// (`PUT /api/v1/checkouts`); the hub never infers one, since it cannot stat a PC.
// The only folders it reports itself are the ones on its own disk.
import { realpath } from 'node:fs/promises';
import { repoKey as repoKeyFromUrl } from '@agentbox/config';
import {
  applyCheckoutReport,
  listCheckouts,
  type AddWorkspaceInput,
  type CheckoutFilter,
  type CheckoutRecord,
  type CheckoutReport,
} from '@agentbox/relay';
import { repoKeyAtEdge } from '@agentbox/sandbox-core';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { hubMachine, type BackendDeps } from './deps';
import type { CheckoutBackend } from '../boxes/backend-types';

/**
 * The checkouts a workspace scan names. The scan already carries each
 * project's origin, and from a current CLI the alias-expanded key too; an older
 * CLI sends only the URL, which is keyed here unexpanded (the hub never guesses
 * at an alias). A scan with no machine id reports nothing.
 */
export function checkoutReportFromScan(input: AddWorkspaceInput): CheckoutReport | null {
  if (!input.machineId) return null;
  const entries = input.projects.flatMap((p) => {
    const key = p.repoKey ?? (p.repoUrl ? repoKeyFromUrl(p.repoUrl) : undefined);
    return key ? [{ repoKey: key, folder: p.path }] : [];
  });
  if (entries.length === 0) return null;
  return { machineId: input.machineId, label: input.host, entries };
}

export function createCheckoutBackend(
  deps: Pick<BackendDeps, 'hostname' | 'machineId' | 'notify'> & { file?: string },
): CheckoutBackend {
  const file = deps.file;
  return {
    listCheckouts(filter: CheckoutFilter = {}): Promise<CheckoutRecord[]> {
      return listCheckouts(filter, file);
    },

    async reportCheckouts(report: CheckoutReport) {
      try {
        const checkouts = await applyCheckoutReport(report, file ? { file } : {});
        deps.notify();
        return { ok: true as const, checkouts };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async recordLocalCheckouts(folders: readonly string[]): Promise<void> {
      const me = hubMachine(deps);
      if (!me.id) return;
      const entries: CheckoutReport['entries'] = [];
      for (const raw of folders) {
        const folder = await realpath(raw).catch(() => raw);
        const origin = await readGitOriginUrl(folder).catch(() => undefined);
        const key = await repoKeyAtEdge(origin);
        if (key) entries.push({ repoKey: key, folder });
      }
      if (entries.length === 0) return;
      await applyCheckoutReport(
        { machineId: me.id, label: me.label, entries },
        file ? { file } : {},
      );
    },
  };
}
