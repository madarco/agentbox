/**
 * Share a provider's **bake state** (`~/.agentbox/<provider>-prepared.json`)
 * between the PC and the control box, via custody's `prepared/` scope.
 *
 * Baking a cloud base (`agentbox prepare --provider hetzner|vercel|e2b|…`) takes
 * minutes and produces a provider-side snapshot that any machine with the
 * provider's API key can boot. But the record of it is per-machine, so a base
 * baked on the control box still looks unbaked to the PC (and vice versa) — each
 * side re-bakes the same thing, and ends up with a different snapshot.
 *
 * Conflict policy is mechanical: **fingerprint-match wins.** A custody record is
 * adopted only if its `base.contextSha256` equals the fingerprint this CLI
 * computes for the same provider. A mismatch means the other side baked from a
 * different build context (a different CLI/runtime), so its snapshot is not the
 * base we'd bake — it is ignored and the normal re-bake proceeds. There is no
 * "newest wins" race: content decides.
 *
 * Everything here is best-effort and offline-safe. The pull runs only where the
 * alternative is a multi-minute bake, so it needs no TTL or caching; a control
 * box that predates the `prepared` scope answers 400, which is treated like 404.
 */
import { readPreparedStateRaw, writePreparedStateRaw } from '@agentbox/sandbox-core';
import type { PreparedProviderKind } from '@agentbox/sandbox-core';
import { deadlineFetch, hostReachable } from './reachability.js';

/** Bound on a bake-record round-trip once the control box is known to be up. */
const PREPARED_FETCH_MS = 10_000;

/** The subset of `PreparedBaseSnapshot` this module reasons about. */
interface PreparedRecord {
  schema?: number;
  base?: { contextSha256?: string; imageRef?: unknown; createdAt?: string };
}

export interface PreparedSyncTarget {
  controlPlaneUrl: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** Custody path holding a provider's bake record. */
export function preparedCustodyPath(provider: PreparedProviderKind): string {
  return `prepared/${provider}.json`;
}

/**
 * A deadline-bound fetch for the control box, or null when it isn't reachable.
 *
 * Bake sharing is best-effort and runs inside `prepare` — a down control box
 * must not stall it. A caller-supplied `fetchImpl` (tests) is used as-is.
 */
async function reachableFetch(target: PreparedSyncTarget): Promise<typeof fetch | null> {
  if (target.fetchImpl) return target.fetchImpl;
  if (!(await hostReachable(target.controlPlaneUrl))) return null;
  return deadlineFetch(AbortSignal.timeout(PREPARED_FETCH_MS));
}

/**
 * Upload this machine's bake record for `provider`. No-op when nothing is baked
 * locally. Hash-skipped by the store itself (`put` reports `changed`).
 * Best-effort: returns false rather than throwing.
 */
export async function pushPreparedToCustody(
  provider: PreparedProviderKind,
  target: PreparedSyncTarget,
): Promise<boolean> {
  const log = target.log ?? (() => {});
  const local = readPreparedStateRaw(provider) as PreparedRecord | null;
  if (!local?.base) return false;
  const fetchImpl = await reachableFetch(target);
  if (!fetchImpl) return false;
  const url = `${target.controlPlaneUrl.replace(/\/+$/, '')}/admin/custody/${preparedCustodyPath(provider)}`;
  try {
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.adminToken}`,
      },
      body: JSON.stringify({
        data: Buffer.from(JSON.stringify(local), 'utf8').toString('base64'),
      }),
    });
    if (!res.ok) {
      log(`prepared: could not share the ${provider} bake with the control box (${String(res.status)})`);
      return false;
    }
    log(`prepared: shared the ${provider} bake with the control box`);
    return true;
  } catch (err) {
    log(`prepared: could not share the ${provider} bake (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

export interface PullPreparedResult {
  /** True when a matching record was fetched and written to local prepared-state. */
  adopted: boolean;
  /** Set when a record was found but its build context differs from ours. */
  mismatch?: { stored: string; current: string };
}

/**
 * Adopt the control box's bake record for `provider` when it matches
 * `currentFingerprint` (this CLI's computed build-context hash).
 *
 * `currentFingerprint` undefined → we can't compare, so nothing is adopted:
 * booting from an unverifiable base is worse than re-baking.
 */
export async function pullPreparedFromCustody(
  provider: PreparedProviderKind,
  currentFingerprint: string | undefined,
  target: PreparedSyncTarget,
): Promise<PullPreparedResult> {
  const log = target.log ?? (() => {});
  if (!currentFingerprint) return { adopted: false };
  const fetchImpl = await reachableFetch(target);
  if (!fetchImpl) return { adopted: false };
  const url = `${target.controlPlaneUrl.replace(/\/+$/, '')}/admin/custody/${preparedCustodyPath(provider)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${target.adminToken}` },
    });
    // 404: nothing shared. 400: a control box older than the `prepared` scope,
    // which rejects the path — same outcome, nothing to adopt.
    if (res.status === 404 || res.status === 400) return { adopted: false };
    if (!res.ok) return { adopted: false };
    const body = (await res.json()) as { data?: string };
    if (typeof body.data !== 'string') return { adopted: false };
    const record = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')) as PreparedRecord;
    const stored = record.base?.contextSha256;
    if (!stored) return { adopted: false };
    if (stored !== currentFingerprint) {
      // The other side baked from a different build context — its snapshot is
      // not the base we would bake. Ignore it rather than boot a stale base.
      log(
        `prepared: the control box's ${provider} bake is from a different build context — ignoring it and baking locally`,
      );
      return { adopted: false, mismatch: { stored, current: currentFingerprint } };
    }
    writePreparedStateRaw(provider, record);
    log(`prepared: adopted the control box's ${provider} base (build context matches — no re-bake needed)`);
    return { adopted: true };
  } catch {
    // Offline / unparseable / unreachable: fall through to a normal bake.
    return { adopted: false };
  }
}
