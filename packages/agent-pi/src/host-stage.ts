/**
 * Pi's host-side staging.
 *
 * Only the credential stager is Pi's own: preferring the `~/.agentbox` backup
 * over the tool's real path is a rule the generic stager has no way to express.
 * The static half is pure `staticPaths` data, so it rides
 * `stageAgentStaticForUpload` with nothing added.
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

export interface StagePiOptions {
  hostHome?: string;
}

/**
 * Filtered tarball of Pi's static config, extracting into
 * `/home/vscode/.pi/agent/`. Source, excludes and layout are all registry data.
 */
export async function stagePiStaticForUpload(opts: StagePiOptions = {}): Promise<StageResult> {
  return stageAgentStaticForUpload('pi', opts);
}

/**
 * Tarball with **only** `auth.json`. Prefers the cloud backup
 * `~/.agentbox/pi-credentials.json` (captured from a previous cloud box); falls
 * back to the host's real `~/.pi/agent/auth.json`. Empty when neither exists.
 */
export async function stagePiCredentialsForUpload(opts: StagePiOptions = {}): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  // Derived from hostHome so the path tracks the active home and tests stay
  // hermetic; production matches the spec's `credential.hostBackup`.
  const cloudBackup = join(hostHome, '.agentbox', 'pi-credentials.json');
  if (await pathExists(cloudBackup)) {
    return stageSingleFileTarball('pi-creds', cloudBackup, 'auth.json');
  }
  const hostAuth = join(hostHome, '.pi', 'agent', 'auth.json');
  if (!(await pathExists(hostAuth))) return emptyResult();
  return stageSingleFileTarball('pi-creds', hostAuth, 'auth.json');
}
