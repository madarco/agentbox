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
 * resolving the control-plane target, skipping docker, pinning the adopted base
 * into config, and never letting a sharing failure affect the bake.
 */
import { boxImageConfigKey, isProviderKind, setConfigValue } from '@agentbox/config';
import type { Provider } from '@agentbox/core';
import { readPreparedStateRaw } from '@agentbox/sandbox-core';
import {
  pullPreparedFromCustody,
  pushPreparedToCustody,
  writePreparedToCustodyStore,
  type PreparedRecord,
} from '@agentbox/sandbox-cloud';
import { resolveCustodyTarget } from '../commands/control-plane.js';
import { getRuntimeProviderNames, loadProviderModule } from '../provider/loaders.js';
import { isShareablePreparedProvider, localBakeBlocksAdoption } from './bake-share.js';

/**
 * Mirror the config pin a real bake writes for the adopted record.
 *
 * Adopting only the prepared-state file is not enough for every provider:
 * daytona resolves its base from `box.imageDaytona`, not from
 * `<provider>-prepared.json`, so an adopted record would sit there while create
 * kept building from the Dockerfile path. `_run-queued-prepare` performs the
 * same write after its own bake; this keeps the adopted path equivalent.
 *
 * Global scope, like the hub's bake: an adopted base is host-wide, not tied to
 * the project directory the command happened to run in.
 */
export async function pinAdoptedBase(
  providerName: string,
  record: PreparedRecord | undefined,
  log: (line: string) => void,
): Promise<void> {
  const imageRef = record?.base?.imageRef;
  if (typeof imageRef !== 'string' || imageRef.length === 0) return;
  if (!isProviderKind(providerName)) return;
  const key = boxImageConfigKey(providerName);
  try {
    await setConfigValue('global', key, imageRef, process.cwd());
    log(`prepared: pinned ${key}=${imageRef} (global)`);
  } catch (err) {
    log(
      `prepared: adopted the ${providerName} base but could not pin ${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Adopt the control box's bake for one provider when it was built from the same
 * build context as ours. Returns true when adopted — the caller then skips the
 * bake entirely.
 *
 * The fingerprint is always probed in NATIVE mode: that is the raw context hash
 * the npm fold derives from, so one probe matches a record baked in either
 * `box.claudeInstall` mode (`matchClaudeInstallFingerprint`).
 *
 * Best-effort: any failure (no control box, offline, no fingerprint) simply
 * means we bake normally.
 */
async function adoptPreparedBase(args: {
  provider: Provider;
  providerName: string;
  log: (line: string) => void;
}): Promise<boolean> {
  if (!isShareablePreparedProvider(args.providerName)) return false;
  try {
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return false;
    const fingerprint = await args.provider.baseFingerprint?.('native');
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
    if (res.adopted) await pinAdoptedBase(args.providerName, res.record, args.log);
    return res.adopted;
  } catch {
    return false;
  }
}

/**
 * Adopt the control box's bake for `providerName` when it was built from the
 * same build context as ours, so a base baked there needs no re-bake here.
 * Returns true when adopted — the caller then skips the bake entirely.
 */
export async function tryAdoptPreparedBase(args: {
  provider: Provider;
  providerName: string;
  log: (line: string) => void;
}): Promise<boolean> {
  return adoptPreparedBase(args);
}

/** Per-provider outcome of a bulk adoption sweep. */
export interface AdoptPreparedBasesResult {
  /** Providers whose base now matches the control box's — nothing to re-bake. */
  adopted: string[];
  /** Providers still without a current base here (nothing shared, or a different context). */
  pending: string[];
}

/**
 * Pull down every cloud bake the control box holds for THIS build context.
 *
 * The counterpart to `syncBakesWithControlBox`'s push. Sharing used to be
 * one-way, so a CLI update that moved the build context left every local cloud
 * base stale and the user was told to spend minutes re-baking — even when the
 * control box already held a base for the exact context we'd bake.
 *
 * Best-effort and offline-safe: a provider we can't adopt is simply reported as
 * pending, never an error.
 */
export async function adoptPreparedBases(): Promise<AdoptPreparedBasesResult> {
  const out: AdoptPreparedBasesResult = { adopted: [], pending: [] };
  const target = await resolveCustodyTarget(undefined, { quiet: true }).catch(() => null);
  if (!target) return out;
  for (const providerName of getRuntimeProviderNames().filter(isShareablePreparedProvider)) {
    let provider: Provider;
    try {
      // `loadProviderModule`, NOT `getProvider`: the latter runs the provider's
      // first-run `ensureCredentials` gate, and this sweep touches EVERY cloud
      // provider — so a background step (the post-update refresh) would open an
      // interactive "Vercel setup" / "E2B setup" wizard for a provider the user
      // never asked for. Adoption needs only `baseFingerprint`, which is a local
      // build-context hash and needs no credential.
      provider = (await loadProviderModule(providerName)).provider;
    } catch {
      continue; // a plugin provider that can't load here is not our problem
    }
    // Silent per provider: a sweep across every provider would otherwise emit a
    // "different build context" line for each one it couldn't take, which is
    // several lines to say nothing happened. The caller reports the outcome once
    // from the lists below. (The single-provider `prepare` path keeps its log —
    // there the user asked about that provider and wants the reason.)
    const adopted = await adoptPreparedBase({ provider, providerName, log: () => {} });
    if (adopted) out.adopted.push(providerName);
    else out.pending.push(providerName);
  }
  return out;
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
