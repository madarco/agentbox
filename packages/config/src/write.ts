import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  configPathFor,
  findProjectRoot,
  hashProjectPath,
  PROJECTS_DIR,
  projectConfigFile,
  projectMetaFile,
} from './paths.js';
import { coerceFromString, parseUserConfig } from './parse.js';
import { withFileLock } from './file-lock.js';
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
 * Set one dotted key in a `config.yaml` **body**, preserving everything else,
 * and return the new body. Pure — no filesystem — so a caller holding a config
 * file that isn't on this machine can merge into it.
 *
 * That is the reason this exists separately from {@link setConfigValue}: the
 * hetzner control-plane deploy has to write `box.claudeInstall` into the VPS's
 * config, which the hub *also* writes itself (`box.remoteDockerHost`). Uploading
 * a freshly-generated file would silently drop the hub's own keys on every
 * redeploy, so the deploy reads the remote body, merges here, and uploads.
 *
 * Validates the merged document the same way `setConfigValue` does; an unknown
 * key or a body whose top level isn't a mapping throws `UserConfigError`.
 */
export function mergeConfigYaml(body: string, key: string, value: unknown): string {
  if (!lookupKey(key)) {
    throw new UserConfigError(`unknown key "${key}"`);
  }
  const doc = parseDocBody(body, '<config.yaml>');
  setLeaf(doc, key, value);
  stampSchema(doc);
  const merged = stringifyYaml(doc);
  parseUserConfig(merged, '<config.yaml>');
  return merged;
}

/**
 * Write a single key into the chosen scope's config file. Creates parent
 * dirs and (for project scope) the meta.json sidecar. Atomic via tmp-rename.
 *
 * The read-modify-write runs under a cross-process file lock: unrelated
 * agentbox processes write the same global `config.yaml` concurrently (two
 * parallel image bakes each pin their own `box.image<Provider>` from a separate
 * detached worker), and without the lock the later writer's read would predate
 * the earlier one's write and silently drop its key.
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
  await withFileLock(path, async () => {
    const current = await readExistingDoc(path);
    setLeaf(current, key, coerced);
    stampSchema(current);
    // Re-parse to validate the merged document; any change that produces an
    // invalid file (shouldn't be possible here, but defence-in-depth) throws.
    parseUserConfig(stringifyYaml(current), path);
    await atomicWriteYaml(path, current);
  });

  if (scope === 'project') {
    const root = (await findProjectRoot(cwd)).root;
    await touchProjectMeta(root);
  }

  return { path, coerced };
}

/**
 * Remove a key from the chosen scope's config file. Empty parent objects are
 * pruned so the file stays tidy. ENOENT is treated as success. Locked like
 * {@link setConfigValue} — same read-modify-write, same lost-update hazard.
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
  const existed = await withFileLock(path, async () => {
    const current = await readExistingDoc(path);
    if (!unsetLeaf(current, key)) return false;
    stampSchema(current);
    await atomicWriteYaml(path, current);
    return true;
  });
  if (!existed) return { path, existed: false };
  if (scope === 'project') {
    const root = (await findProjectRoot(cwd)).root;
    await touchProjectMeta(root);
  }
  return { path, existed: true };
}

export interface ProjectEntry {
  /** SHA-1 (first 16 hex chars) of `originalPath` — the canonical key. */
  hash: string;
  /**
   * On-disk dir name under `PROJECTS_DIR`. Equal to the hash for legacy
   * pre-rename dirs; `<hash>-<mnemonic>` for new dirs. Used directly when we
   * need to `rm` the dir so the call works regardless of which shape happens
   * to be on disk.
   */
  dirName: string;
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
  for (const dirName of entries) {
    // Dir shape is `<sha1-16>` (legacy) or `<sha1-16>-<mnemonic>` (current);
    // either way the leading 16 hex chars are the canonical key.
    const m = /^([0-9a-f]{16})(?:-.+)?$/.exec(dirName);
    if (!m) continue;
    const hash = m[1]!;
    const meta = await readMeta(dirName);
    if (!meta) continue;
    const cfgPath = projectConfigFile(meta.originalPath);
    const hasConfig = await fileExists(cfgPath);
    out.push({
      hash,
      dirName,
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
        // Remove by the on-disk dir name (originalPath is gone, so recomputing
        // the segment from it would be pointless; entry.dirName preserves
        // whichever shape — legacy `<hash>` or new `<hash>-<mnemonic>` —
        // happens to be on disk).
        await rm(join(PROJECTS_DIR, entry.dirName), { recursive: true, force: true });
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
  dirName: string,
): Promise<{ originalPath: string; createdAt: string | null; lastSeenAt: string | null } | null> {
  const metaPath = `${PROJECTS_DIR}/${dirName}/meta.json`;
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

/**
 * Read the file as a RAW yaml mapping for round-tripping. Deliberately not
 * `parseUserConfig`: that drops keys it doesn't recognize, and this document is
 * written straight back to disk — so parsing here would silently DELETE any key
 * the current registry doesn't know (e.g. one written by a newer agentbox) on
 * the next `config set`. Validation of the merged doc still happens in
 * `setConfigValue`; the key being set is validated by `lookupKey`.
 */
/**
 * Parse a config-file body into a mutable doc. An empty/blank body is an empty
 * doc (that's how a first write starts), `label` only names the source in errors.
 */
function parseDocBody(text: string, label: string): Partial<UserConfig> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new UserConfigError(
      `${label}: yaml parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UserConfigError(`${label}: top-level must be a mapping`);
  }
  return doc as Partial<UserConfig>;
}

async function readExistingDoc(path: string): Promise<Partial<UserConfig>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseDocBody(text, path);
}

/**
 * Stamp `schema: 1` on a doc that hasn't been stamped yet. Idempotent — a
 * doc already carrying any `schema` value is left alone. Future schema
 * bumps live here.
 */
const CURRENT_CONFIG_SCHEMA = 1;
function stampSchema(doc: Partial<UserConfig>): void {
  if (typeof doc.schema !== 'number') {
    doc.schema = CURRENT_CONFIG_SCHEMA;
  }
}

function setLeaf(doc: Partial<UserConfig>, key: string, value: unknown): void {
  const segs = key.split('.');
  let cur = doc as unknown as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = cur[seg];
    if (!next || typeof next !== 'object') {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

function unsetLeaf(doc: Partial<UserConfig>, key: string): boolean {
  const segs = key.split('.');
  const path: Record<string, unknown>[] = [doc as unknown as Record<string, unknown>];
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = path[path.length - 1]![seg];
    if (!next || typeof next !== 'object') return false;
    path.push(next as Record<string, unknown>);
  }
  const leafSeg = segs[segs.length - 1]!;
  const leafContainer = path[path.length - 1]!;
  if (!(leafSeg in leafContainer)) return false;
  delete leafContainer[leafSeg];
  // Prune empty parent objects from leaf-most up so the YAML stays tidy.
  for (let i = path.length - 1; i > 0; i--) {
    if (Object.keys(path[i]!).length > 0) break;
    delete path[i - 1]![segs[i - 1]!];
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

/**
 * Register a project (a folder on the PC) in the on-disk registry so it is
 * enumerable via {@link listProjectsConfigured} even before it has any config
 * value or any box. Idempotent: creates `~/.agentbox/projects/<hash>/meta.json`
 * on first call and refreshes `lastSeenAt` (preserving `createdAt`) after.
 *
 * `absPath` should be a canonical project root (e.g. `findProjectRoot(cwd).root`).
 * Callers that start from an arbitrary user path should canonicalize first.
 */
export async function registerProject(absPath: string): Promise<void> {
  await touchProjectMeta(absPath);
}

/**
 * Remove a project from the on-disk registry by its {@link hashProjectPath}
 * hash — deletes `~/.agentbox/projects/<hash>-<mnemonic>/`, i.e. its `meta.json`
 * and any project-scoped `config.yaml` the user set for that folder. Does NOT
 * touch the workspace folder/files, its git repo, or checkpoints (a separate
 * `~/.agentbox/checkpoints/` tree). Idempotent: returns `false` when the hash
 * isn't registered (nothing to remove). Mirrors the delete
 * {@link pruneOrphanProjectConfigs} does (rm by the on-disk `dirName`).
 */
export async function unregisterProject(hash: string): Promise<boolean> {
  const entry = (await listProjectsConfigured()).find((e) => e.hash === hash);
  if (!entry) return false;
  await rm(join(PROJECTS_DIR, entry.dirName), { recursive: true, force: true });
  return true;
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
