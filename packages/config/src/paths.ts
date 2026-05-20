import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ConfigScope } from './types.js';

export const STATE_DIR = join(homedir(), '.agentbox');
export const GLOBAL_CONFIG_FILE = join(STATE_DIR, 'config.yaml');
export const PROJECTS_DIR = join(STATE_DIR, 'projects');
export const WORKSPACE_CONFIG_BASENAME = 'agentbox.yaml';

export interface ProjectRoot {
  /** Absolute path to the resolved project root (host filesystem). */
  root: string;
  hasAgentboxYaml: boolean;
}

/**
 * Walk up from `cwd` until we find an `agentbox.yaml`. That dir is the
 * "project". If no ancestor has one, we fall back to `cwd` (per spec) so
 * `agentbox config` still does something sane in dirs without a workspace
 * file. The returned path is always absolute and **symlink-canonicalised**
 * via `realpath` — without this, macOS's `/tmp` symlink to `/private/tmp`
 * makes `findProjectRoot('/tmp/x')` (at create time, --workspace) and
 * `findProjectRoot(process.cwd())` (at resolve time, the same dir) return
 * different roots, breaking the per-project box index match.
 */
export async function findProjectRoot(cwd: string): Promise<ProjectRoot> {
  const start = await canonicalize(cwd);
  let dir = start;
  // Defensive cap on iterations: filesystem roots end with `dirname(x) === x`.
  for (let i = 0; i < 64; i++) {
    if (await fileExists(join(dir, WORKSPACE_CONFIG_BASENAME))) {
      return { root: dir, hasAgentboxYaml: true };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: start, hasAgentboxYaml: false };
}

async function canonicalize(p: string): Promise<string> {
  const abs = resolve(p);
  // realpath only works for paths that exist. cwd and create-time
  // workspaces always do; fall back to the resolved (non-canonicalised)
  // path for anything else (e.g. config get from a deleted dir).
  try {
    return await realpath(abs);
  } catch {
    return abs;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * SHA-1 (first 16 hex chars) of the *normalised* absolute path. We strip a
 * single trailing slash so `/foo/` and `/foo` hash identically. Case is
 * preserved — macOS APFS is case-preserving and so is the user's intent.
 */
export function hashProjectPath(absPath: string): string {
  const normalised = absPath.length > 1 && absPath.endsWith('/')
    ? absPath.slice(0, -1)
    : absPath;
  return createHash('sha1').update(normalised).digest('hex').slice(0, 16);
}

/**
 * Make `raw` safe to embed as the mnemonic half of an on-disk dir segment or a
 * Docker tag repo. Lowercased so docker tag repos stay valid; `-` collapses to
 * `_` so the single `-` between hash and mnemonic remains the only one (which
 * is what `listProjectsConfigured` parses on). Bounded length, never empty.
 */
export function sanitizeMnemonic(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/-/g, '_')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'unnamed'
  );
}

/**
 * On-disk dir segment for a project under `~/.agentbox/projects/` and
 * `~/.agentbox/checkpoints/`: `<hash>-<mnemonic>`. The hash stays the
 * canonical key; the trailing mnemonic is decorative — readers parse the hash
 * as the leading 16 hex chars and ignore the suffix.
 */
export function projectDirSegment(absPath: string): string {
  return `${hashProjectPath(absPath)}-${sanitizeMnemonic(basename(absPath))}`;
}

export function projectConfigDir(absPath: string): string {
  return join(PROJECTS_DIR, projectDirSegment(absPath));
}

export function projectConfigFile(absPath: string): string {
  return join(projectConfigDir(absPath), 'config.yaml');
}

export function projectMetaFile(absPath: string): string {
  return join(projectConfigDir(absPath), 'meta.json');
}

export function workspaceConfigFile(workspacePath: string): string {
  return join(workspacePath, WORKSPACE_CONFIG_BASENAME);
}

/**
 * Resolve a file path for a given scope. For `global`, no cwd is needed;
 * for `project`, `cwd` selects which project hash. Workspace path uses the
 * resolved project root (the dir holding `agentbox.yaml`, or cwd as fallback).
 */
export async function configPathFor(
  scope: ConfigScope | 'workspace',
  cwd: string,
): Promise<string> {
  if (scope === 'global') return GLOBAL_CONFIG_FILE;
  const root = await findProjectRoot(cwd);
  if (scope === 'project') return projectConfigFile(root.root);
  return workspaceConfigFile(root.root);
}
