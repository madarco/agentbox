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
import {
  pullPreparedFromCustody,
  pushPreparedToCustody,
  writePreparedToCustodyStore,
} from '@agentbox/sandbox-cloud';
import { resolveCustodyTarget } from '../commands/control-plane.js';
import { isShareablePreparedProvider, localBakeBlocksAdoption } from './bake-share.js';

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
  if (!isShareablePreparedProvider(args.providerName)) return false;
  try {
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return false;
    const fingerprint = await args.provider.baseFingerprint?.(args.claudeInstall);
    if (!fingerprint) return false;
    // A local record only rules adoption out when it is CURRENT (see
    // `localBakeBlocksAdoption` for why "any record at all" was wrong).
    const local = readPreparedStateRaw(args.providerName) as {
      base?: { contextSha256?: string };
    } | null;
    if (localBakeBlocksAdoption(local, fingerprint)) return false;
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

/**
 * True when this process belongs to a control box — a deployed hub or one this
 * machine exposed. Both run the resident create worker, and only they do, so the
 * worker gate is also the "I am the custody store" signal. The bake worker is
 * spawned by that hub's relay, so it inherits the variable.
 */
function isControlBox(): boolean {
  return process.env.AGENTBOX_HUB_WORKER === 'on';
}

/**
 * Record this machine's fresh bake so the other side can boot it. Never fails a
 * good bake.
 *
 * A PC pushes to its control box over HTTP. A control box has no control box of
 * its own — `relay.controlPlaneUrl` is unset there *because* it is the control
 * plane — so the push resolved to nothing and its bakes never entered custody,
 * silently: the hub showed "baked" while every PC kept re-baking, and the shared
 * record stayed frozen at whatever a PC last uploaded. It owns the custody store
 * on its own disk, so write straight to it.
 */
export async function sharePreparedBase(
  providerName: string,
  log: (line: string) => void,
): Promise<void> {
  if (!isShareablePreparedProvider(providerName)) return;
  try {
    if (isControlBox()) {
      const { FsCustodyStore } = await import('@agentbox/relay');
      await writePreparedToCustodyStore(providerName, new FsCustodyStore(), log);
      return;
    }
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
