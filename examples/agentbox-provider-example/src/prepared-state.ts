/**
 * Persisted record of what `agentbox prepare --provider example` has built.
 * Lives at `~/.agentbox/example-prepared.json` so `backend.provision` can
 * resolve the base snapshot to boot every box from.
 *
 * AgentBox does NOT pin a plugin's base image into its own config (that's for
 * built-in providers) — a plugin manages its own prepared-state file, which is
 * exactly what this demonstrates. Uses the SDK's schema-agnostic
 * `read/writePreparedStateRaw` + `preparedStatePathFor` primitives.
 */

import {
  claudeInstallFingerprint,
  computeContextSha256,
  readPreparedStateRaw,
  writePreparedStateRaw,
  preparedStatePathFor,
  UserFacingError,
} from '@madarco/agentbox-provider-sdk';
import { resolveRuntimeAssets } from './runtime-assets.js';

/** Provider name → prepared-state file basename (`~/.agentbox/example-prepared.json`). */
const PROVIDER = 'example';
const SCHEMA = 1 as const;

export interface PreparedExampleBase {
  /** Vercel snapshot id (opaque). The thing `Sandbox.create({ source })` boots from. */
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

export interface PreparedExampleState {
  schema: typeof SCHEMA;
  /** The shared base snapshot. Absent until first `agentbox prepare`. */
  base?: PreparedExampleBase;
}

export function preparedStatePath(): string {
  return preparedStatePathFor(PROVIDER);
}

export function readPreparedState(): PreparedExampleState {
  const raw = readPreparedStateRaw(PROVIDER);
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedExampleState>;
  if (parsed.schema !== SCHEMA) return { schema: SCHEMA };
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedState(state: PreparedExampleState): void {
  writePreparedStateRaw(PROVIDER, state);
}

/**
 * Compute the CURRENT build-context fingerprint for the base snapshot (the SHA
 * over every file `prepare` would upload). Side-effect-free — never builds.
 * Returns `undefined` when the runtime assets can't be resolved (e.g. not run
 * through the CLI, so the shared-runtime dir is unknown) so the CLI degrades to
 * "can't tell, don't nag".
 */
export async function currentExampleBaseFingerprintLive(
  claudeInstall: 'native' | 'npm' = 'native',
): Promise<string | undefined> {
  try {
    const assets = resolveRuntimeAssets();
    return claudeInstallFingerprint(
      await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
      claudeInstall,
    );
  } catch {
    return undefined;
  }
}

/**
 * First-use gate. If no base snapshot is recorded, throw an actionable error
 * pointing at `agentbox prepare --provider example`.
 */
export function ensureExampleBaseSnapshot(): void {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new UserFacingError(
    'no base snapshot found for the example provider.\n' +
      'Run `agentbox prepare --provider example` first — it bakes a Vercel base ' +
      'snapshot (a one-time prerequisite, since Vercel cannot build images from a Dockerfile).',
  );
}
