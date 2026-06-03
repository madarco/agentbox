/**
 * Persisted record of what `agentbox prepare --provider e2b` has built.
 * Lives at `~/.agentbox/e2b-prepared.json` so the auto-prepare gate
 * (`ensureE2bBaseTemplate()`) and `backend.provision` can resolve the base
 * template every box boots from.
 *
 * Single tier for now — the shared base template (Debian + agentbox-ctl +
 * agents). Templates on E2B are id+tag-addressed reusable resources, so unlike
 * Vercel snapshots we don't worry about per-box snapshot eviction; one template
 * is reused for every create.
 *
 * Schema versioned so future shape changes can migrate; only `schema: 1` is
 * accepted today.
 */

import { readPreparedStateRaw, writePreparedStateRaw, preparedStatePathFor } from '@agentbox/sandbox-core';
import { UserFacingError } from '@agentbox/core';

const SCHEMA = 1 as const;

export interface PreparedE2bBase {
  /** Opaque E2B template id (e.g. `tmpl_xxxx` or `name:tag`). Sandbox.create({ template }) boots from this. */
  templateId: string;
  /** Human-friendly template name passed to Template.build (e.g. `agentbox-base:latest`). */
  templateName?: string;
  /** Deterministic SHA-256 of the build context (build script + assets). */
  contextSha256?: string;
  /** CLI version that produced this template (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
  /** ISO timestamp of bake completion. */
  createdAt: string;
}

export interface PreparedE2bState {
  schema: typeof SCHEMA;
  /** The shared base template. Absent until first `agentbox prepare`. */
  base?: PreparedE2bBase;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('e2b');
}

export function readPreparedState(): PreparedE2bState {
  const raw = readPreparedStateRaw('e2b');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedE2bState>;
  if (parsed.schema !== SCHEMA) {
    // Unknown/missing schema: refuse to read — the next prepare overwrites it.
    return { schema: SCHEMA };
  }
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedState(state: PreparedE2bState): void {
  writePreparedStateRaw('e2b', state);
}

/** Update one field of the state without forcing callers to read/merge/write. */
export function updatePreparedState(mutate: (s: PreparedE2bState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * First-use gate. If no base template is recorded, throw an actionable error
 * pointing at `agentbox prepare --provider e2b`. Called by `backend.provision`
 * (so `create` / `claude` trip it but `prepare` itself does not — same shape
 * as the hetzner/vercel gates).
 */
export function ensureE2bBaseTemplate(): void {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new UserFacingError(
    'no E2B base template found.\n' +
      'Run `agentbox prepare --provider e2b` first — it bakes a custom template ' +
      'with the agentbox runtime (agentbox-ctl, vscode user, claude/codex/opencode, tmux) ' +
      'so per-box `create` boots ready in seconds.',
  );
}
