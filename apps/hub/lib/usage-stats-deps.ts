// The one set of inputs every `/api/v1/usage/*` route builds `UsageStats` from:
// this hub's history and ledger plus other PCs' usage contributions (Phase 4b).
// One helper, because `usageStats` caches per window: a route that left the
// contributions out would cache an answer the other routes then return.
import { tryGetMachineId } from '@agentbox/config';
import type { UsageStatsDeps } from './backend/usage-stats';

export function hubUsageStatsDeps(): UsageStatsDeps {
  const selfMachineId = tryGetMachineId();
  return {
    history: globalThis.__AGENTBOX_HUB_HISTORY?.repo ?? null,
    ledger: globalThis.__AGENTBOX_HUB_ACTIVITY ?? null,
    contributions: globalThis.__AGENTBOX_HUB_USAGE_CONTRIBUTIONS ?? null,
    ...(selfMachineId ? { selfMachineId } : {}),
  };
}
