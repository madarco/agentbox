/**
 * Shared decision for auto-approving file transfers between a box and the host
 * under `box.autoApproveSafeHostActions`. Used by both the docker (`server.ts`)
 * and cloud (`host-actions.ts`) cp/download handlers so the containment + secret
 * policy can't drift between the two transports.
 *
 * The rule: a transfer auto-approves only when every host-side path it touches
 * resolves *inside the box's project folder* (`workspacePath`), following
 * symlinks. For a host->box copy, a secret-looking source additionally keeps the
 * prompt unless that exact file was already approved via the `carry:` block.
 * Anything else falls back to the interactive confirm — the prompt is never
 * removed, only skipped when provably safe.
 */

import { isContainedInWorkspace, looksLikeSecret, realpathSafe } from '@agentbox/core';

export interface TransferApproveInput {
  /** `box.autoApproveSafeHostActions` (false → always prompt). */
  enabled: boolean;
  /** The box's host project folder; relative paths already resolved against it. */
  workspacePath: string | undefined;
  /**
   * Resolved host-side paths the transfer touches: the *destination* for
   * box->host (cp.toHost / download), the *sources* for host->box (cp.fromHost).
   */
  hostPaths: string[];
  /** Apply the secret-file guard (host->box only). */
  checkSecret: boolean;
  /** realpath'd host sources already approved via `carry:` (secret exemption). */
  carried?: Set<string>;
}

/**
 * True when the transfer may skip the approval prompt. Conservative: any
 * uncontained path, any not-yet-carried secret source, an unknown workspace, or
 * the feature being disabled all return false (→ the caller prompts).
 */
export async function canAutoApproveTransfer(input: TransferApproveInput): Promise<boolean> {
  if (!input.enabled) return false;
  if (!input.workspacePath || input.hostPaths.length === 0) return false;
  for (const p of input.hostPaths) {
    if (!(await isContainedInWorkspace(p, input.workspacePath))) return false;
    if (input.checkSecret && looksLikeSecret(p)) {
      const real = await realpathSafe(p);
      if (!input.carried?.has(real)) return false;
    }
  }
  return true;
}
