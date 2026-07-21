import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './postgres-store.js';
import type { Store } from './store.js';

export type { Store } from './store.js';
export { MemoryStore, type MemoryStoreParts } from './memory-store.js';
export { PostgresStore, type PostgresStoreOptions, SCHEMA_SQL } from './postgres-store.js';

/**
 * Resolve a {@link Store} from a spec string. Used by the deploy adapters:
 *   - undefined / 'memory'        → in-memory (laptop relay, tests).
 *   - 'postgres://…' / 'postgresql://…' → Postgres (hosted control plane).
 * A federated laptop relay builds its RemoteStore directly (Phase 4b), not here.
 */
export function makeStore(spec?: string): Store {
  if (!spec || spec === 'memory') return new MemoryStore();
  if (spec.startsWith('postgres://') || spec.startsWith('postgresql://')) {
    return new PostgresStore({ connectionString: spec });
  }
  throw new Error(`unknown store spec: ${spec}`);
}
