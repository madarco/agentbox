import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './postgres-store.js';
import { SqliteStore } from './sqlite-store.js';
import type { Store } from './store.js';

export type { Store } from './store.js';
export { MemoryStore, type MemoryStoreParts } from './memory-store.js';
export { PostgresStore, type PostgresStoreOptions } from './postgres-store.js';
export { SqliteStore, type SqliteStoreOptions, DEFAULT_SQLITE_STORE_PATH } from './sqlite-store.js';
export { WriteThroughStore, type WriteThroughParts } from './write-through-store.js';
export { PG_SCHEMA_SQL, SQLITE_SCHEMA_SQL } from './schema.js';

/**
 * Resolve a {@link Store} from a spec string. Used by the deploy adapters:
 *   - undefined / 'memory'              → in-memory (laptop relay, tests).
 *   - 'postgres://…' / 'postgresql://…' → Postgres (hosted control plane).
 *   - 'sqlite:<path>' / a bare path     → SQLite (the control box default).
 * A federated laptop relay builds its RemoteStore directly (Phase 4b), not here.
 */
export function makeStore(spec?: string): Store {
  if (!spec || spec === 'memory') return new MemoryStore();
  if (spec.startsWith('postgres://') || spec.startsWith('postgresql://')) {
    return new PostgresStore({ connectionString: spec });
  }
  if (spec.startsWith('sqlite:')) {
    // Accept sqlite:/abs/path, sqlite:relative.db and sqlite://./file.db alike.
    const path = spec.slice('sqlite:'.length).replace(/^\/\//, '');
    if (!path) throw new Error(`store spec has no path: ${spec}`);
    return new SqliteStore({ path });
  }
  // A bare path (absolute, relative, or ':memory:') is a SQLite file.
  if (spec === ':memory:' || spec.startsWith('/') || spec.startsWith('.') || spec.endsWith('.db')) {
    return new SqliteStore({ path: spec });
  }
  throw new Error(`unknown store spec: ${spec}`);
}
