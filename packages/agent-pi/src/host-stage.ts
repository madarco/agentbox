/**
 * Pi's host-side staging.
 *
 * The credential stager is Pi's own: preferring the `~/.agentbox` backup over
 * the tool's real path is a rule the generic stager has no way to express. The
 * static half is `staticPaths` data on the generic stager.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  emptyResult,
  stageAgentStaticForUpload,
  stageSingleFileTarball,
  type StageResult,
} from '@agentbox/sandbox-core';
import type { AgentPushTarget } from '@agentbox/core';
import { piAuthFileHasProviders } from './auth-shape.js';

export interface StagePiOptions {
  hostHome?: string;
}

/**
 * Filtered tarball of Pi's static config, extracting into
 * `/home/vscode/.pi/agent/`. Symlinks are dereferenced on the host, so a skill
 * linked into another host directory arrives as real files, and so does an
 * `mcp.json` that a dotfile manager (stow, chezmoi) made a symlink.
 *
 * One stager for both transports: the cloud bakes / remote-docker seed use the
 * default `'snapshot'` target, the docker volume sync passes `'volume'` (which
 * keeps `auth.json` — that volume is the box's credential store).
 */
export async function stagePiStaticForUpload(
  opts: StagePiOptions & { target?: AgentPushTarget } = {},
): Promise<StageResult> {
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
  // Shape, not existence: staging Pi's first-run `{}` would seed every cloud
  // box with an empty credential that looks present and authenticates nothing.
  const cloudBackup = join(hostHome, '.agentbox', 'pi-credentials.json');
  if (await piAuthFileHasProviders(cloudBackup)) {
    return stageSingleFileTarball('pi-creds', cloudBackup, 'auth.json');
  }
  const hostAuth = join(hostHome, '.pi', 'agent', 'auth.json');
  if (!(await piAuthFileHasProviders(hostAuth))) return emptyResult();
  return stageSingleFileTarball('pi-creds', hostAuth, 'auth.json');
}
