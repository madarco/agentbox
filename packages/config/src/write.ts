import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  configPathFor,
  findProjectRoot,
  hashProjectPath,
  PROJECTS_DIR,
  projectConfigFile,
  projectMetaFile,
} from './paths.js';
import { coerceFromString, parseUserConfig } from './parse.js';
import { type ConfigScope, lookupKey, type UserConfig, UserConfigError } from './types.js';
import { readdir } from 'node:fs/promises';

interface WriteResult {
  path: string;
  /** The value we coerced and stored, after string→typed conversion. */
  coerced: unknown;
}

interface SetOptions {
  /**
   * When true (the CLI `set` path), accept a string and coerce. When false
   * (programmatic), accept any typed value and write it through after a
   * round-trip parse for validation.
   */
  raw?: boolean;
}

/**
 * Write a single key into the chosen scope's config file. Creates parent
 * dirs and (for project scope) the meta.json sidecar. Atomic via tmp-rename.
 */
export async function setConfigValue(
  scope: ConfigScope,
  key: string,
  value: unknown,
  cwd: string,
  opts: SetOptions = {},
): Promise<WriteResult> {
  if (!lookupKey(key)) {
    throw new UserConfigError(`unknown key "${key}"`);
  }

  const coerced = opts.raw && typeof value === 'string'
    ? coerceFromString(key, value)
    : value;

  const path = await configPathFor(scope, cwd);
  const current = await readExistingDoc(path);
  setLeaf(current, key, coerced);
  // Re-parse to validate the merged document; any change that produces an
  // invalid file (shouldn't be possible here, but defence-in-depth) throws.
  parseUserConfig(stringifyYaml(current), path);
  await atomicWriteYaml(path, current);

  if (scope === 'project') {
    const root = (await findProjectRoot(cwd)).root;
    await touchProjectMeta(root);
  }

  return { path, coerced };
}

/**
 * Remove a key from the chosen scope's config file. Empty parent objects are
 * pruned so the file stays tidy. ENOENT is treated as success.
 */
export async function unsetConfigValue(
  scope: ConfigScope,
  key: string,
  cwd: string,
): Promise<{ path: string; existed: boolean }> {
  if (!lookupKey(key)) {
    throw new UserConfigError(`unknown key "${key}"`);
  }
  const path = await configPathFor(scope, cwd);
  const current = await readExistingDoc(path);
  const existed = unsetLeaf(current, key);
  if (!existed) return { path, existed: false };
  await atomicWriteYaml(path, current);
  if (scope === 'project') {
    const root = (await findProjectRoot(cwd)).root;
    await touchProjectMeta(root);
  }
  return { path, existed: true };
}

interface ProjectEntry {
  hash: string;
  originalPath: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  configPath: string;
  hasConfigFile: boolean;
}

/**
 * Enumerate per-project config dirs. The meta.json's recorded
 * `originalPath` is what we report — the hash on disk is opaque.
 */
export async function listProjectsConfigured(): Promise<ProjectEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(PROJECTS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ProjectEntry[] = [];
  for (const hash of entries) {
    if (!/^[0-9a-f]{16}$/.test(hash)) continue;
    const meta = await readMeta(hash);
    if (!meta) continue;
    const cfgPath = projectConfigFile(meta.originalPath);
    const hasConfig = await fileExists(cfgPath);
    out.push({
      hash,
      originalPath: meta.originalPath,
      createdAt: meta.createdAt,
      lastSeenAt: meta.lastSeenAt,
      configPath: cfgPath,
      hasConfigFile: hasConfig,
    });
  }
  out.sort((a, b) => a.originalPath.localeCompare(b.originalPath));
  return out;
}

export interface PruneOrphanProjectConfigsOptions {
  dryRun?: boolean;
  /** Absolute project roots of live boxes — kept even if the folder is gone. */
  protectedPaths?: string[];
}

export interface PruneOrphanProjectConfigsResult {
  removed: { hash: string; originalPath: string }[];
  dryRun: boolean;
}

/**
 * Delete `~/.agentbox/projects/<hash>/` dirs whose recorded `originalPath`
 * workspace folder no longer exists on disk. Conservative by construction:
 * only an ENOENT on `originalPath` counts as orphaned (a transient/permission
 * error is never treated as "deleted"), and any path in `protectedPaths` (the
 * project roots of still-live boxes) is left alone. Best-effort and
 * idempotent — a failed `rm` is swallowed.
 */
export async function pruneOrphanProjectConfigs(
  opts: PruneOrphanProjectConfigsOptions = {},
): Promise<PruneOrphanProjectConfigsResult> {
  const dryRun = opts.dryRun ?? false;
  const keep = new Set(opts.protectedPaths ?? []);
  const removed: { hash: string; originalPath: string }[] = [];
  for (const entry of await listProjectsConfigured()) {
    if (!isAbsolute(entry.originalPath) || keep.has(entry.originalPath)) continue;
    let missing = false;
    try {
      await stat(entry.originalPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
    }
    if (!missing) continue;
    removed.push({ hash: entry.hash, originalPath: entry.originalPath });
    if (!dryRun) {
      try {
        // Remove by the on-disk hash dir name (originalPath is gone, so
        // recomputing the hash from it would be pointless).
        await rm(join(PROJECTS_DIR, entry.hash), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return { removed, dryRun };
}

/**
 * Sidecar counter for the periodic create-time sweep. Lives inside
 * `PROJECTS_DIR` but `listProjectsConfigured` only reads 16-hex-named dirs, so
 * a dotfile here is invisible to it.
 */
const PROJECT_GC_COUNTER_FILE = join(PROJECTS_DIR, '.gc.json');

/** Read `{creates}` (0 if missing/corrupt), increment, atomic-write, return new value. */
export async function bumpProjectGcCounter(): Promise<number> {
  let prior = 0;
  try {
    const parsed = JSON.parse(await readFile(PROJECT_GC_COUNTER_FILE, 'utf8')) as {
      creates?: unknown;
    };
    if (typeof parsed.creates === 'number' && Number.isFinite(parsed.creates)) {
      prior = parsed.creates;
    }
  } catch {
    /* missing or corrupt -> start from 0 */
  }
  const next = prior + 1;
  await mkdir(PROJECTS_DIR, { recursive: true });
  const tmp = `${PROJECT_GC_COUNTER_FILE}.tmp-${process.pid.toString()}-${Date.now().toString(36)}`;
  await writeFile(tmp, JSON.stringify({ creates: next }) + '\n', { encoding: 'utf8', mode: 0o644 });
  await rename(tmp, PROJECT_GC_COUNTER_FILE);
  return next;
}

async function readMeta(
  hash: string,
): Promise<{ originalPath: string; createdAt: string | null; lastSeenAt: string | null } | null> {
  const metaPath = `${PROJECTS_DIR}/${hash}/meta.json`;
  try {
    const text = await readFile(metaPath, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed['originalPath'] !== 'string') return null;
    return {
      originalPath: parsed['originalPath'],
      createdAt: typeof parsed['createdAt'] === 'string' ? parsed['createdAt'] : null,
      lastSeenAt: typeof parsed['lastSeenAt'] === 'string' ? parsed['lastSeenAt'] : null,
    };
  } catch {
    return null;
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

async function readExistingDoc(path: string): Promise<Partial<UserConfig>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseUserConfig(text, path);
}

function setLeaf(doc: Partial<UserConfig>, key: string, value: unknown): void {
  const idx = key.indexOf('.');
  const branch = key.slice(0, idx);
  const leaf = key.slice(idx + 1);
  const root = doc as unknown as Record<string, Record<string, unknown>>;
  if (!root[branch] || typeof root[branch] !== 'object') {
    root[branch] = {};
  }
  root[branch][leaf] = value;
}

function unsetLeaf(doc: Partial<UserConfig>, key: string): boolean {
  const idx = key.indexOf('.');
  const branch = key.slice(0, idx);
  const leaf = key.slice(idx + 1);
  const root = doc as unknown as Record<string, Record<string, unknown>>;
  const b = root[branch];
  if (!b || typeof b !== 'object' || !(leaf in b)) return false;
  delete b[leaf];
  if (Object.keys(b).length === 0) {
    delete root[branch];
  }
  return true;
}

async function atomicWriteYaml(path: string, doc: Partial<UserConfig>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // YAML serialises empty objects as `{}` which is correct but ugly; if the
  // doc is empty we still want a usable placeholder file.
  const text = Object.keys(doc).length === 0
    ? '# managed by agentbox config — empty\n'
    : stringifyYaml(doc);
  const tmp = `${path}.tmp-${process.pid.toString()}-${Date.now().toString(36)}`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o644 });
  await rename(tmp, path);
}

async function touchProjectMeta(absPath: string): Promise<void> {
  const dir = dirname(projectMetaFile(absPath));
  await mkdir(dir, { recursive: true });
  const metaPath = projectMetaFile(absPath);
  let prior: { originalPath?: string; createdAt?: string } = {};
  try {
    prior = JSON.parse(await readFile(metaPath, 'utf8')) as typeof prior;
  } catch {
    /* fresh file */
  }
  const now = new Date().toISOString();
  const next = {
    originalPath: absPath,
    hash: hashProjectPath(absPath),
    createdAt: prior.createdAt ?? now,
    lastSeenAt: now,
  };
  const tmp = `${metaPath}.tmp-${process.pid.toString()}-${Date.now().toString(36)}`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  await rename(tmp, metaPath);
}

// Re-export for ergonomics; same path resolution as the loader uses.
export { configPathFor };
