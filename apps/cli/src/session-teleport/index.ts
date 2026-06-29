/**
 * Session-teleport entry point. The agent commands call this AFTER the box is
 * provisioned (so `provider.uploadPath` has a target) and BEFORE the in-box
 * agent CLI launches. It:
 *   1. Resolves the matching host session file (claude/codex/opencode-specific).
 *   2. Stages a rewritten copy on the host (cwd → /workspace).
 *   3. Uploads it into the box at the agent-CLI-expected location via
 *      `provider.uploadPath`.
 *   4. Returns the canonical argv tokens the agent command should prepend to
 *      the in-box invocation.
 *
 * v1 supports `-c` and `--resume <id>` for claude + codex. opencode throws a
 * "not yet supported" `TeleportError`.
 */

import type { BoxRecord, Provider } from '@agentbox/core';
import { resolveClaudeTeleport } from './claude.js';
import { resolveCodexTeleport } from './codex.js';
import { resolveOpencodeTeleport } from './opencode.js';
import {
  TeleportError,
  type ResolvedTeleport,
  type ResumeMode,
  type TeleportAgent,
  type TeleportLogger,
} from './types.js';

export {
  TeleportError,
  type ResolvedTeleport,
  type ResumeMode,
  type TeleportAgent,
  type TeleportLogger,
} from './types.js';

export interface PrepareTeleportInput {
  agent: TeleportAgent;
  hostCwd: string;
  mode: ResumeMode;
  log?: TeleportLogger;
}

export interface UploadTeleportInput {
  box: BoxRecord;
  provider: Provider;
  resolved: ResolvedTeleport;
  log?: TeleportLogger;
}

/**
 * Host-side resolve: finds the matching host session, rewrites cwd to
 * `/workspace`, stages a tmp copy ready for upload. No box / provider needed
 * — call this BEFORE box creation as a pre-flight so users don't pay for a
 * doomed box. Throws `TeleportError` on missing/unmatchable sessions.
 */
export async function prepareTeleport(
  input: PrepareTeleportInput,
): Promise<ResolvedTeleport> {
  switch (input.agent) {
    case 'claude':
      return resolveClaudeTeleport({
        hostCwd: input.hostCwd,
        mode: input.mode,
        log: input.log,
      });
    case 'codex':
      return resolveCodexTeleport({
        hostCwd: input.hostCwd,
        mode: input.mode,
        log: input.log,
      });
    case 'opencode':
      // Throws TeleportError immediately — v1 stub.
      resolveOpencodeTeleport();
  }
}

/**
 * Provider-side upload: pushes the prepared session file into the live box.
 * Call AFTER box creation, before the in-box agent CLI launches.
 */
export async function uploadTeleport(input: UploadTeleportInput): Promise<void> {
  if (!input.provider.uploadPath) {
    throw new TeleportError(
      `provider '${input.provider.name}' does not support file upload; session teleport is unavailable on this backend.`,
    );
  }
  // Trailing slash → uploadPath treats dst as a directory and lands the file
  // under its existing basename, which already matches the in-box filename.
  await input.provider.uploadPath(input.box, [input.resolved.hostFile], `${input.resolved.boxParentDir}/`);
  input.log?.(
    `teleport: uploaded ${input.resolved.sessionId} into ${input.resolved.boxParentDir}/`,
  );
}
