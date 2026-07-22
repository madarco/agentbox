/**
 * Persisted record of what `agentbox prepare --provider tenki` has resolved.
 * Lives at `~/.agentbox/tenki-prepared.json` so the auto-prepare gate
 * (`ensureTenkiBaseImage()`) and `backend.provision` can resolve the base
 * image every box boots from.
 *
 * Unlike E2B (which bakes a template from a build DSL), Tenki boots a session
 * from a registry image ref (`workspace/name:tag`) or a snapshot id. The
 * "base" recorded here is the Tenki registry ref carrying the AgentBox runtime
 * (agentbox-ctl, the agents, tmux) — published into the workspace registry by
 * `prepare`. Per-box `create` then boots from it in seconds.
 *
 * Schema versioned so future shape changes can migrate; only `schema: 1` is
 * accepted today.
 */

import {
  readPreparedStateRaw,
  writePreparedStateRaw,
  preparedStatePathFor,
} from '@agentbox/sandbox-core';
import { UserFacingError } from '@agentbox/core';

const SCHEMA = 1 as const;

export interface PreparedTenkiBase {
  /** Tenki registry image ref the AgentBox runtime is published under (e.g. `ws-slug/agentbox-box:latest`). createAndWait({ image }) boots from this. */
  image: string;
  /** Human-friendly artifact name passed to publishRegistryImage (informational). */
  imageName?: string;
  /** CLI version that produced this base (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
  /** ISO timestamp of prepare completion. */
  createdAt: string;
}

export interface PreparedTenkiState {
  schema: typeof SCHEMA;
  /** The shared base image ref. Absent until first `agentbox prepare`. */
  base?: PreparedTenkiBase;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('tenki');
}

export function readPreparedState(): PreparedTenkiState {
  const raw = readPreparedStateRaw('tenki');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedTenkiState>;
  if (parsed.schema !== SCHEMA) {
    // Unknown/missing schema: refuse to read — the next prepare overwrites it.
    return { schema: SCHEMA };
  }
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedState(state: PreparedTenkiState): void {
  writePreparedStateRaw('tenki', state);
}

/** Update one field of the state without forcing callers to read/merge/write. */
export function updatePreparedState(mutate: (s: PreparedTenkiState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * CURRENT build-context fingerprint for the tenki base. Tenki boots from a
 * registry image the user controls (published by `prepare`), not an
 * asset-baked template, so there is no reproducible host-side fingerprint to
 * diff against — `prepare` instead skip-checks the resolved ref directly
 * against `tenki-prepared.json.base.image`. Returning `undefined` makes the
 * cross-provider freshness nudge degrade to "can't tell, don't nag" (the same
 * contract the other providers use when assets can't be resolved).
 */
export async function currentTenkiBaseFingerprintLive(): Promise<string | undefined> {
  return undefined;
}

/**
 * First-use gate. If no base image is recorded, throw an actionable error
 * pointing at `agentbox prepare --provider tenki`. Called by
 * `backend.provision` (so `create` / `claude` trip it but `prepare` itself
 * does not — same shape as the hetzner / vercel / e2b gates).
 */
export function ensureTenkiBaseImage(): void {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new UserFacingError(
    'no Tenki base image found.\n' +
      'Run `agentbox prepare --provider tenki` first — it publishes a registry image ' +
      'with the agentbox runtime (agentbox-ctl, claude/codex/opencode, tmux) into your ' +
      'Tenki workspace so per-box `create` boots ready in seconds.',
  );
}
