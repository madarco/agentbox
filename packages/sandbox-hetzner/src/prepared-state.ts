/**
 * Persisted record of what `agentbox prepare --provider hetzner` has built.
 * Lives at `~/.agentbox/hetzner-prepared.json` so the auto-prepare gate
 * (`ensureHetznerBaseSnapshot()`) and runtime image resolution can see it.
 *
 * Two tiers are recorded (matching the daytona shape — see
 * `docs/cloud-create-flow.md` §"base vs project snapshot"):
 *   - `base` — built once per Hetzner project / API token. Ubuntu + deps +
 *     agentbox-ctl + agents + agent-browser, baked from `install-box.sh`.
 *   - `projects[<projectHash>]` — optional per-project snapshot built after
 *     the first successful `agentbox create` for that project; subsequent
 *     creates for the same project boot from it instead of re-seeding
 *     workspace / agent credentials over SSH.
 *
 * Schema versioned so future shape changes can migrate; we'll only ever
 * accept `schema: 1` for now.
 */

import { preparedStatePathFor, readPreparedStateRaw, writePreparedStateRaw } from '@agentbox/sandbox-core';

/**
 * Schema history:
 *   1 — `base.imageId`, `base.description`, `base.createdAt`,
 *       `base.installScriptSha256?`
 *   2 — `base.installScriptSha256` → `base.contextSha256` (now covers every
 *       asset we scp'd in, not just the install script); `base.cliVersion`
 *       and `base.cliCommit?` added so we can warn when an old snapshot
 *       predates the running CLI.
 *
 * Read-time migration is lossy in one direction: a schema-1 file is lifted
 * to schema 2 by *renaming* `installScriptSha256` to `contextSha256`. The
 * hash doesn't change but the meaning narrows (install script only → full
 * asset list), so the next `agentbox prepare --provider hetzner` run will
 * recompute and overwrite.
 */
const SCHEMA = 2 as const;

export interface PreparedBaseSnapshot {
  /** Hetzner image id (numeric — opaque, but stable across `getImage` calls). */
  imageId: number;
  /** User-facing description (matches the firewall-dashboard rows). */
  description: string;
  /** ISO timestamp of bake-completion. */
  createdAt: string;
  /**
   * Deterministic SHA-256 of the build context (every file scp'd into the
   * prepare VPS). Rebuild when it changes.
   */
  contextSha256?: string;
  /** CLI version that produced this snapshot (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
}

export interface PreparedProjectSnapshot {
  imageId: number;
  description: string;
  createdAt: string;
  /** Bake source — what was in /workspace when we snapshotted. */
  fromSandboxId?: string;
}

export interface PreparedHetznerState {
  schema: typeof SCHEMA;
  /** The shared base snapshot. Absent until first `agentbox prepare`. */
  base?: PreparedBaseSnapshot;
  /** Per-project snapshots, keyed by the agentbox project hash. */
  projects: Record<string, PreparedProjectSnapshot>;
}

interface LegacyV1Base {
  imageId: number;
  description: string;
  createdAt: string;
  installScriptSha256?: string;
}

interface LegacyV1State {
  schema: 1;
  base?: LegacyV1Base;
  projects?: Record<string, PreparedProjectSnapshot>;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('hetzner');
}

export function readPreparedState(): PreparedHetznerState {
  const raw = readPreparedStateRaw('hetzner');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA, projects: {} };
  const parsed = raw as Partial<PreparedHetznerState> | LegacyV1State;
  if ((parsed as { schema?: unknown }).schema === 1) {
    const v1 = parsed as LegacyV1State;
    return migrateFromV1(v1);
  }
  if (parsed.schema !== SCHEMA) {
    // Unknown schema: don't crash, just refuse to read — the file will be
    // overwritten on the next successful prepare.
    return { schema: SCHEMA, projects: {} };
  }
  return {
    schema: SCHEMA,
    base: parsed.base,
    projects: parsed.projects ?? {},
  };
}

function migrateFromV1(v1: LegacyV1State): PreparedHetznerState {
  // The v1 `installScriptSha256` covered only `install-box.sh`, not the full
  // asset list a v2 `contextSha256` represents. Lifting it forward as a
  // placeholder fingerprint means the next prepare run will mismatch and
  // rebuild — exactly what we want, since the broader hash semantics also
  // changed.
  const base: PreparedBaseSnapshot | undefined = v1.base
    ? {
        imageId: v1.base.imageId,
        description: v1.base.description,
        createdAt: v1.base.createdAt,
        contextSha256: v1.base.installScriptSha256,
      }
    : undefined;
  return {
    schema: SCHEMA,
    base,
    projects: v1.projects ?? {},
  };
}

export function writePreparedState(state: PreparedHetznerState): void {
  writePreparedStateRaw('hetzner', state);
}

/**
 * Convenience helper: update one field of the state without forcing callers
 * to read/merge/write themselves.
 */
export function updatePreparedState(mutate: (s: PreparedHetznerState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}
