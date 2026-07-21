/**
 * Concern: dynamic Claude config — the global `~/.claude/workflows/` scripts and
 * the current project's `memory/` tree. Unlike the static config
 * (plugins/skills/settings) that the cloud path bakes into the prepare-time
 * snapshot, these change between runs and must be refreshed per-box at create —
 * like credentials.
 *
 * These pieces are provider-neutral and pure where possible, so both the docker
 * volume sync and the cloud `seedDynamicConfig` reuse them:
 *
 *   - `buildHostSyncManifest` hashes every file in each set on the host.
 *   - `computeSyncDelta` diffs that against the manifest the box already
 *     carries (captured by any checkpoint/snapshot), yielding the minimal set
 *     of files to upload + delete and the manifest to write back.
 *   - `stageDynamicSyncTarball` packs only the changed files into one tarball
 *     whose members are laid out by set name, so the box `cp -a`s each set into
 *     place without tar touching shared parent-dir perms.
 *
 * The box stores its manifest at {@link BOX_DYNAMIC_SYNC_MANIFEST}. Because it
 * lives on the box filesystem it rides along in every checkpoint, so a
 * checkpoint boot naturally syncs only what changed on the host since.
 *
 * Moved here (from `@agentbox/sandbox-docker`'s `dynamic-sync.ts`) so the cloud
 * path reuses it without importing the docker package. `sandbox-docker`
 * re-exports these for its existing importers.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execa } from 'execa';
import {
  BOX_CLAUDE_PROJECT_DIR,
  resolveClaudeMemoryDir,
} from '../agents/claude/paths.js';

/** In-box destination for the global workflow scripts. */
export const BOX_WORKFLOWS_DIR = '/home/vscode/.claude/workflows';

/** In-box path of the per-box dynamic-sync manifest (rides along in checkpoints). */
export const BOX_DYNAMIC_SYNC_MANIFEST = '/home/vscode/.agentbox/dynamic-sync.json';

/** In-box destination for the current project's rekeyed memory. */
export const BOX_MEMORY_DIR = `${BOX_CLAUDE_PROJECT_DIR}/memory`;

export type DynamicSyncSetName = 'workflows' | 'memory';

/** A set's box destination dir + per-file content hashes (relpath -> sha256 hex). */
export interface DynamicSyncSet {
  dst: string;
  files: Record<string, string>;
}

/** Persisted shape written to {@link BOX_DYNAMIC_SYNC_MANIFEST}. */
export interface DynamicSyncManifest {
  version: 1;
  syncedAt?: string;
  sets: Record<DynamicSyncSetName, DynamicSyncSet>;
}

/** Host-side set: like {@link DynamicSyncSet} plus the source dir to read bytes from. */
interface HostSyncSet extends DynamicSyncSet {
  /** Absolute host source dir, or null when this set has nothing on the host. */
  hostDir: string | null;
}

export interface HostSyncManifest {
  sets: Record<DynamicSyncSetName, HostSyncSet>;
}

export interface DynamicSyncUpload {
  set: DynamicSyncSetName;
  /** Path relative to the set's dir. */
  rel: string;
  /** Absolute host source file. */
  absSrc: string;
  /** Absolute box destination file (`dst/rel`). */
  dst: string;
}

export interface DynamicSyncDeletion {
  set: DynamicSyncSetName;
  rel: string;
  /** Absolute box file to remove. */
  dst: string;
}

export interface DynamicSyncDelta {
  uploads: DynamicSyncUpload[];
  deletions: DynamicSyncDeletion[];
  /** Manifest to persist into the box after applying the delta (host state). */
  nextManifest: DynamicSyncManifest;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively collect regular-file relpaths under `root` (posix-separated). */
async function walkFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = join(root, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkFiles(full, rel)));
    } else if (ent.isFile()) {
      out.push(rel);
    } else if (ent.isSymbolicLink()) {
      // Follow only symlinks that resolve to a regular file (e.g. a workflow
      // symlinked from a checkout); ignore dangling/dir links.
      try {
        const s = await stat(full);
        if (s.isFile()) out.push(rel);
      } catch {
        /* skip dangling */
      }
    }
  }
  return out;
}

async function hashFile(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  return createHash('sha256').update(buf).digest('hex');
}

async function buildHostSet(
  name: DynamicSyncSetName,
  hostDir: string | null,
  boxDst: string,
): Promise<HostSyncSet> {
  if (hostDir === null) return { dst: boxDst, files: {}, hostDir: null };
  const rels = await walkFiles(hostDir);
  const files: Record<string, string> = {};
  for (const rel of rels) {
    files[rel] = await hashFile(join(hostDir, rel));
  }
  return { dst: boxDst, files, hostDir };
}

/**
 * Hash the host's workflow + memory sets. `workspacePath` is the host-absolute
 * project path (used to locate the project's memory dir); `hostHome` is
 * overridable for tests. Sets with nothing on the host get an empty `files` map
 * and `hostDir: null` so the diff can still emit deletions for them.
 */
export async function buildHostSyncManifest(
  workspacePath: string,
  hostHome: string = homedir(),
): Promise<HostSyncManifest> {
  const workflowsDir = join(hostHome, '.claude', 'workflows');
  const workflowsHost = (await pathExists(workflowsDir)) ? workflowsDir : null;
  const memoryHost = await resolveClaudeMemoryDir(workspacePath, hostHome);
  const [workflows, memory] = await Promise.all([
    buildHostSet('workflows', workflowsHost, BOX_WORKFLOWS_DIR),
    buildHostSet('memory', memoryHost, BOX_MEMORY_DIR),
  ]);
  return { sets: { workflows, memory } };
}

const SET_NAMES: DynamicSyncSetName[] = ['workflows', 'memory'];

/**
 * Diff the host manifest against the manifest the box already carries. A file
 * is uploaded when its hash differs (new or changed); a file in the box
 * manifest absent on the host is deleted. Pure — no IO, no clock.
 */
export function computeSyncDelta(
  host: HostSyncManifest,
  box: DynamicSyncManifest | null,
): DynamicSyncDelta {
  const uploads: DynamicSyncUpload[] = [];
  const deletions: DynamicSyncDeletion[] = [];
  const nextSets = {} as Record<DynamicSyncSetName, DynamicSyncSet>;

  for (const name of SET_NAMES) {
    const hostSet = host.sets[name];
    const boxFiles = box?.sets?.[name]?.files ?? {};
    for (const [rel, hash] of Object.entries(hostSet.files)) {
      if (boxFiles[rel] !== hash) {
        uploads.push({
          set: name,
          rel,
          absSrc: join(hostSet.hostDir as string, rel),
          dst: `${hostSet.dst}/${rel}`,
        });
      }
    }
    for (const rel of Object.keys(boxFiles)) {
      if (!(rel in hostSet.files)) {
        deletions.push({ set: name, rel, dst: `${hostSet.dst}/${rel}` });
      }
    }
    nextSets[name] = { dst: hostSet.dst, files: hostSet.files };
  }

  return { uploads, deletions, nextManifest: { version: 1, sets: nextSets } };
}

export interface StagedTarball {
  /** Absolute path to the .tar.gz, or null when there was nothing to upload. */
  tarballPath: string | null;
  /** Remove the staging dir + tarball. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Pack the upload files into one gzip tarball laid out by set name
 * (`workflows/<rel>`, `memory/<rel>`). The box extracts into a staging dir and
 * `cp -a`s each set into its destination, so tar never touches the perms of
 * shared parent dirs (`/`, `/home`). Returns `{ tarballPath: null }` when
 * `uploads` is empty.
 */
export async function stageDynamicSyncTarball(
  uploads: DynamicSyncUpload[],
): Promise<StagedTarball> {
  if (uploads.length === 0) {
    return { tarballPath: null, cleanup: async () => {} };
  }
  const stageDir = await mkdtemp(join(tmpdir(), 'agentbox-dynsync-stage-'));
  let tarballPath: string | null = null;
  try {
    for (const up of uploads) {
      const target = join(stageDir, up.set, up.rel);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(up.absSrc, target);
    }
    tarballPath = join(tmpdir(), `agentbox-dynsync-${basename(stageDir)}.tar.gz`);
    // COPYFILE_DISABLE=1: stop macOS bsdtar from emitting AppleDouble sidecars.
    await execa('tar', ['-czf', tarballPath, '-C', stageDir, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const tp = tarballPath;
    return {
      tarballPath: tp,
      cleanup: async () => {
        await rm(stageDir, { recursive: true, force: true });
        await rm(tp, { force: true });
      },
    };
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    if (tarballPath) await rm(tarballPath, { force: true });
    throw err;
  }
}
