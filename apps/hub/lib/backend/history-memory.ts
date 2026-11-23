// Agent memory in the hub (docs/agent-history-plan.md, Phase 4): every version
// of every memory file, keyed by (repo key, agent, scope, path). Per-file
// last-writer-wins, nothing is ever overwritten. Edges reach it through the
// relay (`memory.seed` / `memory.put`); people through `/api/v1/history/memory`.
//
// Same seam as the transcript store: `MemoryRepo` holds rows (sqlite here),
// this file holds no SQL.
import { createHash } from 'node:crypto';
import {
  MEMORY_FILE_MAX_BYTES,
  MEMORY_MAX_FILES,
  safeMemoryPath,
  type HistoryMemorySink,
  type MemoryOrigin,
} from '@agentbox/core';

export type MemoryScope = 'project' | 'global';

export interface MemoryVersionRow {
  id: number;
  repoKey: string;
  agent: string;
  scope: MemoryScope;
  path: string;
  version: number;
  sha256: string;
  size: number;
  deleted: boolean;
  /** null for a version imported from the hub machine's own agent dir. */
  boxId: string | null;
  boxName: string | null;
  provider: string | null;
  hostId: string | null;
  createdAt: number;
}

export type NewMemoryVersion = Omit<MemoryVersionRow, 'id' | 'version'>;

export interface MemoryKey {
  repoKey: string;
  agent: string;
  scope: MemoryScope;
}

export interface MemoryRepo {
  /** The newest version of every path under `key`, tombstones included. */
  latest(key: MemoryKey): Promise<MemoryVersionRow[]>;
  /** Every version of one path, oldest first. */
  versions(key: MemoryKey, path: string): Promise<MemoryVersionRow[]>;
  content(id: number): Promise<Buffer | null>;
  /** Append a version (`max + 1`) atomically. */
  insert(row: NewMemoryVersion, content: Buffer | null): Promise<MemoryVersionRow>;
  /** One row per (repo, agent, scope) with its live file count and last write. */
  sets(): Promise<Array<MemoryKey & { files: number; versions: number; updatedAt: number }>>;
}

export interface MemoryFileView {
  path: string;
  version: number;
  sha256: string;
  size: number;
  deleted: boolean;
  updatedAt: number;
  origin: {
    boxId: string | null;
    boxName: string | null;
    provider: string | null;
    hostId: string | null;
  };
}

export interface MemoryService extends HistoryMemorySink {
  sets(): Promise<Array<MemoryKey & { files: number; versions: number; updatedAt: number }>>;
  /** Live files (latest version, not deleted) of one set; with `includeDeleted`, tombstones too. */
  list(key: MemoryKey, opts?: { includeDeleted?: boolean }): Promise<MemoryFileView[]>;
  versions(key: MemoryKey, path: string): Promise<MemoryFileView[]>;
  /** A version's bytes (default: the latest); null when absent or a tombstone. */
  file(
    key: MemoryKey,
    path: string,
    version?: number,
  ): Promise<{ view: MemoryFileView; bytes: Buffer } | null>;
}

function view(r: MemoryVersionRow): MemoryFileView {
  return {
    path: r.path,
    version: r.version,
    sha256: r.sha256,
    size: r.size,
    deleted: r.deleted,
    updatedAt: r.createdAt,
    origin: { boxId: r.boxId, boxName: r.boxName, provider: r.provider, hostId: r.hostId },
  };
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function createMemoryService(deps: { repo: MemoryRepo; now?: () => number }): MemoryService {
  const { repo } = deps;
  const now = deps.now ?? Date.now;
  // One writer: two puts of one path must get distinct, ordered versions.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const append = async (
    key: MemoryKey,
    path: string,
    bytes: Uint8Array | null,
    origin: MemoryOrigin,
  ): Promise<{ version: number; changed: boolean }> => {
    const prev = (await repo.versions(key, path)).at(-1);
    const digest = bytes ? sha(bytes) : '';
    // Same content as the latest (or deleting what is already gone): no version.
    if (prev && (bytes ? !prev.deleted && prev.sha256 === digest : prev.deleted)) {
      return { version: prev.version, changed: false };
    }
    if (!prev && !bytes) return { version: 0, changed: false };
    const row = await repo.insert(
      {
        ...key,
        path,
        sha256: digest,
        size: bytes?.length ?? 0,
        deleted: !bytes,
        boxId: origin.boxId,
        boxName: origin.boxName ?? null,
        provider: origin.provider ?? null,
        hostId: origin.hostId ?? null,
        createdAt: now(),
      },
      bytes ? Buffer.from(bytes) : null,
    );
    return { version: row.version, changed: true };
  };

  const checkPath = (path: string): string => {
    const p = safeMemoryPath(path);
    if (!p) throw new Error(`invalid memory path: ${path}`);
    return p;
  };

  return {
    memorySeed(input) {
      return serialized(async () => {
        const key: MemoryKey = { repoKey: input.repoKey, agent: input.agent, scope: input.scope };
        const known = new Set((await repo.latest(key)).map((r) => r.path));
        // The host copy is one more writer in the last-writer-wins order. A
        // host file is imported when this host never imported that path, or
        // when it changed since its last import here; an unchanged host file
        // never overrides a newer box version (a box edit wins until the host
        // edits again).
        for (const f of input.hostFiles) {
          const p = safeMemoryPath(f.path);
          if (!p || f.bytes.length > MEMORY_FILE_MAX_BYTES) continue;
          if (!known.has(p) && known.size >= MEMORY_MAX_FILES) continue;
          const lastFromHost = (await repo.versions(key, p))
            .filter(
              (v) =>
                v.boxId === null &&
                v.provider === input.origin.provider &&
                v.hostId === (input.origin.hostId ?? null),
            )
            .at(-1);
          if (lastFromHost && !lastFromHost.deleted && lastFromHost.sha256 === sha(f.bytes))
            continue;
          await append(key, p, f.bytes, input.origin);
          known.add(p);
        }
        const out: Array<{ path: string; bytes: Uint8Array; sha256: string }> = [];
        for (const r of await repo.latest(key)) {
          if (r.deleted) continue;
          const bytes = await repo.content(r.id);
          if (bytes) out.push({ path: r.path, bytes, sha256: r.sha256 });
        }
        return out;
      });
    },

    memoryPut(input) {
      return serialized(async () => {
        if (input.bytes && input.bytes.length > MEMORY_FILE_MAX_BYTES) {
          throw new Error(`memory file over ${String(MEMORY_FILE_MAX_BYTES)} bytes: ${input.path}`);
        }
        const key: MemoryKey = { repoKey: input.repoKey, agent: input.agent, scope: input.scope };
        return append(key, checkPath(input.path), input.bytes, input.origin);
      });
    },

    sets: () => repo.sets(),

    async list(key, opts) {
      return (await repo.latest(key)).filter((r) => opts?.includeDeleted || !r.deleted).map(view);
    },

    async versions(key, path) {
      return (await repo.versions(key, path)).map(view);
    },

    async file(key, path, version) {
      const all = await repo.versions(key, path);
      const row = version === undefined ? all.at(-1) : all.find((r) => r.version === version);
      if (!row || row.deleted) return null;
      const bytes = await repo.content(row.id);
      return bytes ? { view: view(row), bytes } : null;
    },
  };
}
