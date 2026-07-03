// Accessors the v1 routes use to reach box state, mirroring lib/boxes/source.ts's
// resolution order so the same route handlers work across topologies:
//   - mutations (create/lifecycle/approvals) need the in-process host backend
//     (globalThis, set by the embedded server); the Postgres/plane path has no
//     in-process writer, so writes 503 there for now (hosted writes are a
//     documented follow-up).
//   - reads (boxes/projects/approvals) go through getDashboardData(), which
//     already falls back in-process -> Postgres -> empty, so the read contract is
//     topology-agnostic for free.
import { getDashboardData } from '@/lib/boxes/source';
import type { HubBackend } from '@/lib/boxes/backend-types';
import type { HubState } from '@/lib/boxes/types';

export function backendOrNull(): HubBackend | null {
  return globalThis.__AGENTBOX_HUB_BACKEND ?? null;
}

// Topology-agnostic read of the full hub state (boxes/projects/approvals).
export async function readState(): Promise<HubState> {
  return getDashboardData();
}
