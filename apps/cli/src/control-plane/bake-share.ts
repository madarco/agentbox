/**
 * Pure logic for sharing this machine's bake records with the control box and
 * predicting whether the control box will actually ACCEPT them.
 *
 * The control box adopts a shared `prepared/<provider>.json` only when its
 * `base.contextSha256` equals the fingerprint the hub computes for the same
 * provider (`hydratePreparedFromCustody` → `matchClaudeInstallFingerprint`). A
 * push always succeeds if the box is reachable, so a plain "shared it" is not
 * the whole truth: a record from a different build context is uploaded and then
 * silently ignored, and the hub re-bakes. Callers need to say so.
 *
 * Two things break the match, both knowable here without a hub round-trip — a
 * local record stale vs THIS CLI's build context, and a deployed hub running a
 * different AgentBox version. This module classifies each, so setup/deploy can
 * end with an explicit per-provider "will need baking again" message.
 *
 * Everything here is pure (fingerprints/versions in, verdict out) so it is unit
 * testable without a hub or the filesystem.
 */
import { matchClaudeInstallFingerprint } from '@agentbox/sandbox-core';
import type { PushDecision } from './custody-client.js';

/**
 * The ONE rule for "does this provider bake a base worth sharing?" — derive the
 * provider set from it (enumerate the runtime providers and filter), never a
 * hardcoded list, or a new built-in / community-plugin provider is silently
 * skipped from bake sharing.
 *
 * A cloud provider's base is an id-addressed snapshot any machine with the API
 * key can boot, so it is worth sharing. `docker` is not: its base is a local
 * image rebuilt (or pulled) per machine. `remote-docker` is the non-obvious
 * case — despite living on another host, its base is still a local docker image
 * built on that host, not a portable snapshot, so it is docker-shaped and
 * excluded the same way.
 */
export function isShareablePreparedProvider(provider: string): boolean {
  return provider !== 'docker' && provider !== 'remote-docker';
}

/**
 * Whether what this machine already has rules out adopting the control box's
 * bake: only a record that matches OUR live build context does.
 *
 * The rule used to be "any local record at all", which inverted the intent — the
 * machine that most needs the shared base, one holding an outdated record, was
 * the only one that could never take it, and re-baked for minutes instead. A
 * record from a different context is precisely what adoption is for. (Adopting
 * something *worse* isn't a risk: the pull only writes when custody's
 * fingerprint equals ours.)
 */
export function localBakeBlocksAdoption(
  local: { base?: { contextSha256?: string } } | null,
  liveFingerprint: string,
): boolean {
  return local?.base?.contextSha256 === liveFingerprint;
}

/**
 * The change-detection predicate for the credential re-push: true when at least
 * one item is due for upload (its hash differs from custody), false when every
 * item is a hash-skip. Callers use it to stay silent when nothing changed.
 */
export function hasCredentialChanges(plan: PushDecision[]): boolean {
  return plan.some((d) => d.action === 'upload');
}

export interface BakeShareInput {
  provider: string;
  /** The local record's `base.contextSha256`, or undefined when nothing is baked here. */
  storedFingerprint: string | undefined;
  /**
   * This CLI's live native fingerprint for the same provider, or undefined when
   * it can't be computed (a dev tree with no staged runtime). Undefined disables
   * the local-staleness check — an unverifiable base must not be flagged.
   */
  cliNativeFingerprint: string | undefined;
  /** The version the deployed hub reports (`/healthz`), or undefined when it doesn't. */
  hubVersion: string | undefined;
  /** This CLI's own version. */
  cliVersion: string;
  /**
   * Whether the record's upload to custody actually succeeded. When false the
   * record never left this machine, so no verdict about the hub's fingerprint
   * applies — the outcome is `share-failed`, never a false `match`.
   */
  pushSucceeded: boolean;
}

export type BakeShareStatus =
  /** Nothing baked locally — nothing to share. */
  | 'not-baked'
  /** The upload to custody failed, so nothing was shared (the hub will re-bake). */
  | 'share-failed'
  /** Shared; the hub's fingerprint will match, so its first create boots the base. */
  | 'match'
  /** Shared; the hub computes a different fingerprint, so it will re-bake. */
  | 'mismatch';

export interface BakeShareResult {
  provider: string;
  status: BakeShareStatus;
  /** Present for `mismatch` / `share-failed`: why the hub won't boot the record. */
  reason?: string;
}

/**
 * Predict whether the control box will boot this machine's bake record for
 * `provider`.
 *
 * - The upload has to have actually succeeded; a swallowed push failure must
 *   never be reported as a share (that is the false "Shared it" bug).
 * - A local record whose fingerprint matches neither install-mode fold of THIS
 *   CLI's build context is stale here too: no same-version hub would take it.
 * - A hub on a different version has a different build context, so the record —
 *   even one perfectly current for this CLI — won't match on the far side.
 */
export function classifyBakeShare(input: BakeShareInput): BakeShareResult {
  const { provider, storedFingerprint, cliNativeFingerprint, hubVersion, cliVersion } = input;
  if (!storedFingerprint) return { provider, status: 'not-baked' };
  if (!input.pushSucceeded) {
    return {
      provider,
      status: 'share-failed',
      reason: `could not upload the ${provider} bake record to the control box`,
    };
  }
  if (
    cliNativeFingerprint &&
    !matchClaudeInstallFingerprint(storedFingerprint, cliNativeFingerprint)
  ) {
    return {
      provider,
      status: 'mismatch',
      reason: `the local ${provider} bake predates this CLI's build context — re-run \`agentbox prepare --provider ${provider}\``,
    };
  }
  if (hubVersion && hubVersion !== cliVersion) {
    return {
      provider,
      status: 'mismatch',
      reason: `the hub runs ${hubVersion} but this CLI is ${cliVersion}, so its build context differs`,
    };
  }
  return { provider, status: 'match' };
}

export interface BakeShareSummary {
  /** Providers whose record the hub will boot from (status `match`). */
  matched: string[];
  /** Providers shared but that the hub will re-bake (status `mismatch`). */
  mismatched: BakeShareResult[];
  /** Providers whose upload failed, so nothing was shared (status `share-failed`). */
  shareFailed: BakeShareResult[];
}

export function summarizeBakeShare(results: BakeShareResult[]): BakeShareSummary {
  return {
    matched: results.filter((r) => r.status === 'match').map((r) => r.provider),
    mismatched: results.filter((r) => r.status === 'mismatch'),
    shareFailed: results.filter((r) => r.status === 'share-failed'),
  };
}

/**
 * The end-of-setup message for providers the hub will have to bake again, or
 * null when there is nothing to warn about. Per-provider and explicit: staying
 * silent here is the bug this reports against.
 */
export function buildRebakeNote(mismatched: BakeShareResult[]): string | null {
  if (mismatched.length === 0) return null;
  const lines = mismatched.map(
    (m) => `  - ${m.provider}: ${m.reason ?? 'the build context differs'}`,
  );
  return (
    'These providers are configured, but the hub will need to bake them again before its first box:\n' +
    lines.join('\n')
  );
}

/**
 * The message for bakes whose upload failed (e.g. the box was unreachable) — a
 * distinct outcome from `mismatch`: there the record reached the hub and was
 * rejected on its fingerprint; here it never arrived. Returns null when nothing
 * failed. Sharing stays best-effort, so this warns rather than failing setup.
 */
export function buildShareFailedNote(shareFailed: BakeShareResult[]): string | null {
  if (shareFailed.length === 0) return null;
  const names = shareFailed.map((r) => r.provider);
  return (
    'Could not share these base bake records with the control box, so the hub will re-bake them on ' +
    `first use: ${names.join(', ')}.\n` +
    'Re-run `agentbox hub setup` (or `agentbox prepare --provider <name>`) once it is reachable to share them.'
  );
}
