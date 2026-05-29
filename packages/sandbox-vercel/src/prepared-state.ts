/**
 * Persisted record of what `agentbox prepare --provider vercel` has built.
 * Lives at `~/.agentbox/vercel-prepared.json` so the auto-prepare gate
 * (`ensureVercelBaseSnapshot()`) and `backend.provision` can resolve the base
 * snapshot to boot every box from.
 *
 * Single tier for now — the shared base snapshot (AL2023 + deps + agentbox-ctl
 * + agents). A per-project snapshot tier (matching the hetzner/daytona shape)
 * is a future optimization tracked in docs/vercel-backlog.md.
 *
 * Schema versioned so future shape changes can migrate; only `schema: 1` is
 * accepted today.
 */

import { readPreparedStateRaw, writePreparedStateRaw, preparedStatePathFor } from '@agentbox/sandbox-core';

const SCHEMA = 1 as const;

export interface PreparedVercelBase {
  /** Vercel snapshot id (opaque). The thing `Sandbox.create({ source }) ` boots from. */
  snapshotId: string;
  /** Deterministic SHA-256 of the prepare build context (provision.sh + assets). */
  contextSha256?: string;
  /** CLI version that produced this snapshot (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
  /** ISO timestamp of bake completion. */
  createdAt: string;
}

export interface PreparedVercelState {
  schema: typeof SCHEMA;
  /** The shared base snapshot. Absent until first `agentbox prepare`. */
  base?: PreparedVercelBase;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('vercel');
}

export function readPreparedState(): PreparedVercelState {
  const raw = readPreparedStateRaw('vercel');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedVercelState>;
  if (parsed.schema !== SCHEMA) {
    // Unknown/missing schema: refuse to read — the next prepare overwrites it.
    return { schema: SCHEMA };
  }
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedState(state: PreparedVercelState): void {
  writePreparedStateRaw('vercel', state);
}

/** Update one field of the state without forcing callers to read/merge/write. */
export function updatePreparedState(mutate: (s: PreparedVercelState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * First-use gate. If no base snapshot is recorded, throw an actionable error
 * pointing at `agentbox prepare --provider vercel`. Called by `backend.provision`
 * (indirectly via the snapshot resolution) and usable by the CLI.
 */
export function ensureVercelBaseSnapshot(): void {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new Error(
    'no Vercel base snapshot found.\n' +
      'Run `agentbox prepare --provider vercel` first — Vercel cannot build images ' +
      'from a Dockerfile, so the base snapshot is a one-time prerequisite for cloud boxes.',
  );
}
