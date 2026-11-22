// The checkouts registry (docs/box-sources-plan.md §4): "machine M has repo R at
// folder F", keyed by machine id and repo key. PCs report their own folders
// (`PUT /api/v1/checkouts`); the hub never infers one, since it cannot stat a PC.
// The only folders it reports itself are the ones on its own disk.
import {
  applyCheckoutReport,
  listCheckouts,
  type CheckoutFilter,
  type CheckoutRecord,
  type CheckoutReport,
} from '@agentbox/relay';
import { checkoutEntriesFor } from '@agentbox/sandbox-core';
import { hubMachine, type BackendDeps } from './deps';
import type { CheckoutBackend } from '../boxes/backend-types';

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
      const entries = await checkoutEntriesFor(folders);
      if (entries.length === 0) return;
      await applyCheckoutReport(
        { machineId: me.id, label: me.label, entries },
        file ? { file } : {},
      );
    },
  };
}
