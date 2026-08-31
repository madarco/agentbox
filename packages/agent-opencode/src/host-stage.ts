/**
 * OpenCode's host-side staging.
 *
 * Two of these are more than a copy — the credentials tarball prefers a cloud
 * backup over the host's real `auth.json`, and the model-state tarball ships a
 * single file from a different tree — so they cannot be expressed as
 * `staticPaths` data. The static one IS pure data; it stays here beside its
 * siblings rather than being the one opencode stager living somewhere else.
 *
 * These lived in `sandbox-core/src/sync/host-stage.ts` while the published SDK
 * exported them by name. SDK v3 replaced the three per-agent stagers with
 * `stageAllAgentStatic`, which reaches an agent's own through
 * `AgentCloudModule.stageStatic` — so the last reason to keep them in a shared
 * layer that must not know about agents is gone. The rsync/tar primitives they
 * use are still exported from `sandbox-core`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  emptyResult,
  pathExists,
  stageAgentStaticForUpload,
  stageSingleFileTarball,
  type StageResult,
} from '@agentbox/sandbox-core';

export interface StageOpencodeOptions {
  hostHome?: string;
}

/**
 * Filtered tarball of opencode static config. Layout extracts into
 * `/home/vscode/.local/share/opencode/`:
 *
 *   ./<data files>            ← from ~/.local/share/opencode/ (minus auth.json)
 *   ./config/<config files>   ← from ~/.config/opencode/
 *
 * Both sources, their `relocToSubpath` and their excludes are registry data, so
 * this is the generic stager with nothing added. `auth.json` and the two-way
 * state tree ship separately (their own variants below).
 */
export async function stageOpencodeStaticForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  return stageAgentStaticForUpload('opencode', opts);
}

/**
 * Tarball with **only** `auth.json`. Prefers the cloud backup
 * `~/.agentbox/opencode-credentials.json` (captured from a previous cloud box);
 * falls back to the host's real `~/.local/share/opencode/auth.json`. Returns an
 * empty result when neither exists.
 */
export async function stageOpencodeCredentialsForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  // Cloud backup under <hostHome>/.agentbox, derived from hostHome so the path
  // tracks the active home and tests stay hermetic; production matches
  // OPENCODE_CREDENTIALS_BACKUP_FILE.
  const cloudBackup = join(hostHome, '.agentbox', 'opencode-credentials.json');
  if (await pathExists(cloudBackup)) {
    return stageSingleFileTarball('opencode-creds', cloudBackup, 'auth.json');
  }
  const hostAuth = join(hostHome, '.local', 'share', 'opencode', 'auth.json');
  if (!(await pathExists(hostAuth))) return emptyResult();
  return stageSingleFileTarball('opencode-creds', hostAuth, 'auth.json');
}

/**
 * Tarball with **only** the selected-model state (`model.json`, sourced from
 * `~/.local/state/opencode/model.json`). Extracts to a box's state dir so a
 * fresh box inherits the host's active model instead of OpenCode's default.
 * Returns an empty result when the host has never picked a model.
 */
export async function stageOpencodeStateForUpload(
  opts: StageOpencodeOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostModel = join(hostHome, '.local', 'state', 'opencode', 'model.json');
  if (!(await pathExists(hostModel))) return emptyResult();
  return stageSingleFileTarball('opencode-state', hostModel, 'model.json');
}
