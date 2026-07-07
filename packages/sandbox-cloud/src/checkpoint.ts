/**
 * Cloud checkpoint store — parallel to `packages/sandbox-docker/src/checkpoint.ts`
 * but backed by provider-native snapshots (Daytona's `_experimental_createSnapshot`)
 * instead of local Docker image tags.
 *
 * Each user-facing checkpoint (`setup`, `with-deps`, …) is scoped to a project
 * and stored as a thin manifest on the host:
 *
 *   ~/.agentbox/cloud-checkpoints/<backend>/<projectHash-mnemonic>/<name>/manifest.json
 *
 * The manifest maps the project-scoped name to a provider-unique snapshot name
 * — Daytona snapshots are org-wide, so the snapshot name is prefixed with the
 * project hash to avoid collisions across projects (and across users in the
 * same org).
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { CloudBackend } from '@agentbox/core';
import { hashProjectPath, projectDirSegment, sanitizeMnemonic } from '@agentbox/config';
import { type PreparedProviderKind, readPreparedStateRaw } from '@agentbox/sandbox-core';

export const CLOUD_CHECKPOINTS_ROOT = join(homedir(), '.agentbox', 'cloud-checkpoints');

/**
 * All cloud snapshot names share this prefix so a stray `agentbox-ckpt-*`
 * snapshot in the Daytona dashboard is clearly recognisable as AgentBox's.
 * Mirrors `CHECKPOINT_IMAGE_PREFIX` from the docker package.
 */
export const CLOUD_SNAPSHOT_NAME_PREFIX = 'agentbox-ckpt-';

export interface CloudCheckpointManifest {
  /**
   * Schema history:
   *   1 — original fields (no base fingerprint; staleness unverifiable)
   *   2 — adds `baseProvider`, `baseFingerprint`, `cliVersion` so the wizard
   *       can tell a checkpoint captured against a now-rebuilt base snapshot
   *       from a fresh one. A legacy schema-1 manifest has no fingerprint and
   *       is treated as "stale / unverifiable" by `evaluateCheckpoint`.
   */
  schema: 1 | 2;
  /** User-facing, project-scoped name (e.g. "setup"). */
  name: string;
  /** Cloud backend the snapshot lives in (e.g. "daytona"). */
  backend: string;
  /**
   * Provider-unique snapshot name — what the backend's `createSnapshot()` was
   * called with, and what gets passed to `provision({ snapshot })` on restore.
   */
  snapshotName: string;
  sourceBoxId: string;
  sourceBoxName: string;
  /**
   * Cloud provider whose base-snapshot fingerprint this checkpoint was
   * captured against. Schema-2+ only.
   */
  baseProvider?: string;
  /**
   * Build-context fingerprint of the base snapshot at capture time (the
   * provider's `prepared-state` `contextSha256`). Schema-2+ only; missing →
   * legacy schema-1 → "unverifiable / stale".
   */
  baseFingerprint?: string;
  /** CLI version that captured the checkpoint. Schema-2+ only. */
  cliVersion?: string;
  createdAt: string;
}

export interface CloudCheckpointInfo {
  name: string;
  /** Host dir holding `manifest.json`. */
  dir: string;
  manifest: CloudCheckpointManifest;
}

/**
 * Deterministic provider-unique snapshot name for a project checkpoint. The
 * project-hash prefix prevents collisions across projects (and across users
 * in the same Daytona org); the mnemonic suffix keeps the Daytona dashboard
 * readable. The leading `agentbox-ckpt-` lets cleanup scripts recognise our
 * snapshots.
 */
export function cloudSnapshotName(projectRoot: string, name: string): string {
  const mnemonic = sanitizeMnemonic(basename(projectRoot));
  return `${CLOUD_SNAPSHOT_NAME_PREFIX}${hashProjectPath(projectRoot)}_${mnemonic}-${name}`;
}

function backendDir(backend: string, projectRoot: string): string {
  return join(CLOUD_CHECKPOINTS_ROOT, backend, projectDirSegment(projectRoot));
}

/**
 * Backend names that have a checkpoint directory under `CLOUD_CHECKPOINTS_ROOT`.
 * Lets the CLI's `checkpoint list` surface checkpoints from **plugin** cloud
 * providers (whose names aren't in the built-in `CLOUD_PROVIDER_NAMES`) without
 * loading them — a checkpoint store is just named directories on disk.
 */
export async function listCloudBackendDirs(): Promise<string[]> {
  try {
    return (await readdir(CLOUD_CHECKPOINTS_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function checkpointDir(backend: string, projectRoot: string, name: string): string {
  return join(backendDir(backend, projectRoot), name);
}

async function readManifest(dir: string): Promise<CloudCheckpointManifest | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as CloudCheckpointManifest;
    if (m.schema !== 1 && m.schema !== 2) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Read every valid cloud checkpoint manifest directly under `root` (a backend's
 * `<hash>-<mnemonic>` project dir), sorted by `createdAt`. Shared by the scoped
 * and global listers. Missing root / unreadable manifests are skipped.
 */
async function listCloudCheckpointsInDir(root: string): Promise<CloudCheckpointInfo[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: CloudCheckpointInfo[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    const manifest = await readManifest(dir);
    if (manifest) out.push({ name, dir, manifest });
  }
  out.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
  return out;
}

export async function listCloudCheckpoints(
  projectRoot: string,
  backend: string,
): Promise<CloudCheckpointInfo[]> {
  return listCloudCheckpointsInDir(backendDir(backend, projectRoot));
}

export interface CloudCheckpointProjectGroup {
  /** `<hash>-<mnemonic>` dir name under CLOUD_CHECKPOINTS_ROOT/<backend>/. */
  segment: string;
  items: CloudCheckpointInfo[];
}

/**
 * Every project's cloud checkpoints for `backend`, one group per project dir.
 * Best-effort: a missing backend root returns `[]`, and segments with zero
 * valid manifests are dropped. Used by `checkpoints -g`.
 */
export async function listAllCloudCheckpoints(
  backend: string,
): Promise<CloudCheckpointProjectGroup[]> {
  const backendRoot = join(CLOUD_CHECKPOINTS_ROOT, backend);
  let segments: string[];
  try {
    segments = (await readdir(backendRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: CloudCheckpointProjectGroup[] = [];
  for (const segment of segments) {
    const items = await listCloudCheckpointsInDir(join(backendRoot, segment));
    if (items.length > 0) out.push({ segment, items });
  }
  return out;
}

export async function resolveCloudCheckpoint(
  projectRoot: string,
  backend: string,
  ref: string,
): Promise<CloudCheckpointInfo | null> {
  const dir = checkpointDir(backend, projectRoot, ref);
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  return { name: ref, dir, manifest };
}

export interface WriteCloudManifestFields {
  snapshotName: string;
  sourceBoxId: string;
  sourceBoxName: string;
  baseProvider?: string;
  baseFingerprint?: string;
  cliVersion?: string;
}

export async function writeCloudCheckpointManifest(
  projectRoot: string,
  backend: string,
  name: string,
  fields: WriteCloudManifestFields,
): Promise<CloudCheckpointInfo> {
  const dir = checkpointDir(backend, projectRoot, name);
  await mkdir(dir, { recursive: true });
  const manifest: CloudCheckpointManifest = {
    schema: 2,
    name,
    backend,
    snapshotName: fields.snapshotName,
    sourceBoxId: fields.sourceBoxId,
    sourceBoxName: fields.sourceBoxName,
    baseProvider: fields.baseProvider,
    baseFingerprint: fields.baseFingerprint,
    cliVersion: fields.cliVersion,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { name, dir, manifest };
}

/**
 * Current base-snapshot build-context fingerprint for a cloud provider, read
 * from its `~/.agentbox/<provider>-prepared.json`. Returns `undefined` when no
 * prepared state exists or it predates fingerprinting — callers then can't
 * verify staleness and must not falsely flag a checkpoint as stale.
 */
export function currentCloudBaseFingerprint(provider: string): string | undefined {
  try {
    const raw = readPreparedStateRaw(provider as PreparedProviderKind) as {
      base?: { contextSha256?: string };
    } | null;
    return raw?.base?.contextSha256;
  } catch {
    return undefined;
  }
}

/**
 * Freshness of a cloud provider's baked base image / snapshot, derived purely
 * from the `contextSha256` of the baked runtime files.
 *
 * **Checksum-only.** CLI version strings stored alongside the fingerprint are
 * informational and MUST NOT influence the decision: a CLI bump that doesn't
 * change any baked file produces an identical hash → `fresh`.
 */
export type BaseStatus =
  /** No prepared base on disk. */
  | { state: 'unprepared' }
  /**
   * Can't compute the live fingerprint (e.g. a dev tree with no built ctl
   * bundle). Inert: callers must not prompt for a rebuild they can't verify.
   */
  | { state: 'unknown' }
  /** Stored fingerprint differs from current — the baked runtime is out of date. */
  | { state: 'stale'; reason: string }
  /** Stored fingerprint matches current. */
  | { state: 'fresh' };

/**
 * Provider-agnostic compare that turns a stored + live build-context
 * fingerprint into a {@link BaseStatus}. Shared by the CLI wizard/doctor
 * (`evaluateBaseFreshness`) and the hub so the state model and the `stale`
 * reason string never drift between them. `stored`/`live` are resolved by the
 * caller (`currentCloudBaseFingerprint` + the provider's
 * `currentBaseFingerprintLive`); docker has no baked base and should not reach
 * here.
 */
export function baseFreshnessFromFingerprints(
  stored: string | undefined,
  live: string | undefined,
): BaseStatus {
  if (!stored) return { state: 'unprepared' };
  if (!live) return { state: 'unknown' };
  if (stored !== live) {
    return {
      state: 'stale',
      reason: `baked runtime differs (base ${stored.slice(0, 12)}, current ${live.slice(0, 12)})`,
    };
  }
  return { state: 'fresh' };
}

export async function removeCloudCheckpointDir(
  projectRoot: string,
  backend: string,
  name: string,
): Promise<boolean> {
  const dir = checkpointDir(backend, projectRoot, name);
  const existed = (await readManifest(dir)) !== null;
  if (!existed) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Probe whether a cloud checkpoint's underlying provider snapshot is still
 * bootable, pruning the dangling local manifest when it has expired or been
 * deleted out-of-band. Lets the create / wizard paths recover gracefully —
 * fall back to a from-scratch box and re-ask the setup wizard — instead of
 * letting `provision()` 410 on a snapshot that no longer exists.
 *
 * Returns `{ live: false }` when there is no manifest for `ref`. When the
 * backend can't probe (`snapshotExists` unimplemented) the snapshot is assumed
 * live: we never prune on uncertainty.
 */
export async function probeCloudCheckpoint(
  backend: Pick<CloudBackend, 'name' | 'snapshotExists'>,
  projectRoot: string,
  ref: string,
): Promise<{ live: boolean; pruned: boolean }> {
  const found = await resolveCloudCheckpoint(projectRoot, backend.name, ref);
  if (!found) return { live: false, pruned: false };
  if (!backend.snapshotExists) return { live: true, pruned: false };
  const live = await backend.snapshotExists(found.manifest.snapshotName);
  if (live) return { live: true, pruned: false };
  await removeCloudCheckpointDir(projectRoot, backend.name, ref);
  return { live: false, pruned: true };
}
