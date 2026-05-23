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
import { hashProjectPath, projectDirSegment, sanitizeMnemonic } from '@agentbox/config';

export const CLOUD_CHECKPOINTS_ROOT = join(homedir(), '.agentbox', 'cloud-checkpoints');

/**
 * All cloud snapshot names share this prefix so a stray `agentbox-ckpt-*`
 * snapshot in the Daytona dashboard is clearly recognisable as AgentBox's.
 * Mirrors `CHECKPOINT_IMAGE_PREFIX` from the docker package.
 */
export const CLOUD_SNAPSHOT_NAME_PREFIX = 'agentbox-ckpt-';

export interface CloudCheckpointManifest {
  schema: 1;
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

function checkpointDir(backend: string, projectRoot: string, name: string): string {
  return join(backendDir(backend, projectRoot), name);
}

async function readManifest(dir: string): Promise<CloudCheckpointManifest | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as CloudCheckpointManifest;
    if (m.schema !== 1) return null;
    return m;
  } catch {
    return null;
  }
}

export async function listCloudCheckpoints(
  projectRoot: string,
  backend: string,
): Promise<CloudCheckpointInfo[]> {
  const root = backendDir(backend, projectRoot);
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
    schema: 1,
    name,
    backend,
    snapshotName: fields.snapshotName,
    sourceBoxId: fields.sourceBoxId,
    sourceBoxName: fields.sourceBoxName,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { name, dir, manifest };
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
