/**
 * The CLI side of sharing a provider's bake with the control box.
 *
 * Two bake paths exist — the interactive `agentbox prepare` and the hub's queued
 * `_run-queued-prepare` — and BOTH must apply the same policy, or a bake done
 * from the web UI and one done from the terminal disagree about what "already
 * baked" means. So the policy lives here once rather than in each command.
 *
 * The transport-level rules (fingerprint-match-wins, 400-as-404) live in
 * `@agentbox/sandbox-cloud`'s `prepared-sync`; this adds the CLI's concerns:
 * resolving the control-plane target, skipping docker, and never letting a
 * sharing failure affect the bake.
 */
import type { Provider } from '@agentbox/core';
import { readPreparedStateRaw } from '@agentbox/sandbox-core';
import { pullPreparedFromCustody, pushPreparedToCustody } from '@agentbox/sandbox-cloud';
import { resolveCustodyTarget } from '../commands/control-plane.js';

/**
 * Docker's base is a local image built or pulled per machine — not a
 * provider-side snapshot another host could boot — so there is nothing to share.
 */
function isShareable(providerName: string): boolean {
  return providerName !== 'docker';
}

/**
 * Adopt the control box's bake for `providerName` when it was built from the
 * same build context as ours, so a base baked there needs no re-bake here.
 * Returns true when adopted — the caller then skips the bake entirely.
 *
 * Best-effort: any failure (no control box, offline, no fingerprint) simply
 * means we bake normally.
 */
export async function tryAdoptPreparedBase(args: {
  provider: Provider;
  providerName: string;
  claudeInstall: 'native' | 'npm';
  log: (line: string) => void;
}): Promise<boolean> {
  if (!isShareable(args.providerName)) return false;
  try {
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return false;
    // Already baked here → nothing to adopt; the normal prepare path decides
    // whether the local record is stale.
    const local = readPreparedStateRaw(args.providerName) as { base?: unknown } | null;
    if (local?.base) return false;
    const fingerprint = await args.provider.baseFingerprint?.(args.claudeInstall);
    if (!fingerprint) return false;
    const res = await pullPreparedFromCustody(args.providerName, fingerprint, {
      controlPlaneUrl: target.url,
      adminToken: target.adminToken,
      log: args.log,
    });
    return res.adopted;
  } catch {
    return false;
  }
}

/** Share this machine's fresh bake with the control box. Never fails a good bake. */
export async function sharePreparedBase(
  providerName: string,
  log: (line: string) => void,
): Promise<void> {
  if (!isShareable(providerName)) return;
  try {
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return;
    await pushPreparedToCustody(providerName, {
      controlPlaneUrl: target.url,
      adminToken: target.adminToken,
      log,
    });
  } catch {
    /* sharing is a convenience */
  }
}
