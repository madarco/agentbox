/**
 * The external-provider plugin registry: `~/.agentbox/plugins.json`.
 *
 * A community provider ships as its own npm package (`agentbox-provider-<name>`)
 * built against `@madarco/agentbox-provider-sdk`. The user installs it themselves, then
 * `agentbox plugin add <pkg>` validates it and records it here; the CLI and the
 * host relay both read this file to resolve + lazily `import()` the package at
 * runtime (a true variable specifier — built-ins are bundle-inlined, external
 * providers are not).
 *
 * Concurrency + durability mirror `state.ts`: an O_EXCL lockfile guards the
 * read-modify-write, and writes are atomic (temp + rename). Reads have a sync
 * variant so the CLI's synchronous `isKnownProvider`/name-list checks can
 * consult it without going async.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderDescriptor } from '@agentbox/config';

export const PLUGINS_FILE = join(homedir(), '.agentbox', 'plugins.json');

/**
 * `SDK_API_VERSION` majors this CLI can load. A plugin built against an SDK
 * whose major is not listed is refused at `plugin add` and skipped at load
 * (with a warning) rather than crashing the CLI. Extend this array when the CLI
 * keeps back-compat with an older provider contract.
 */
// v2: BoxRecord.cloud.ssh moved to top-level BoxRecord.ssh (+port, docker sshd
// fields). v1 plugins still load — only ones reading box.cloud.ssh notice.
//
// v3: the three per-agent staging exports (`stage<Agent>StaticForUpload`) are
// replaced by the registry-driven `stageAllAgentStatic`. Unlike v2 this is a
// CLEAN BREAK — v1 and v2 are no longer accepted — because a v2 provider stages
// a hardcoded three agents, so on a host with a fourth it bakes a snapshot that
// silently lacks it. Loading such a plugin would produce wrong boxes rather
// than a missing feature, which is worse than refusing it. A v2 plugin is
// refused at `plugin add` and skipped at load with a message naming the version.
//
// v4: agent settings. `PrepareOptions.claudeInstall` is replaced by the generic
// `agentSettings` map, `resolveAgentInstall` takes that agent's settings rather
// than a mode string, `Provider.baseFingerprint` takes no arguments (an
// agentless base folds no agent setting), and `claudeInstallFingerprint` is
// gone. A CLEAN BREAK for the same reason v3 was: a v3 provider silently drops
// every agent setting, so on a host that set `claude.install: npm` it bakes a
// base with the recipe the user chose specifically because it fails there — a
// wrong artifact rather than a missing feature.
export const SUPPORTED_SDK_API_VERSIONS: readonly number[] = [4];

export function isSupportedApiVersion(v: number): boolean {
  return SUPPORTED_SDK_API_VERSIONS.includes(v);
}

/** One registered external provider package. */
export interface PluginRecord {
  /** Package name as installed (e.g. `agentbox-provider-digitalocean`). */
  packageName: string;
  /** Absolute path to the package's resolved entry module, recorded at add time. */
  resolvedEntry: string;
  /** Package version at add time (informational). */
  version: string;
  /** Provider names this package contributes (from each `providerModule.provider.name`). */
  providers: string[];
  /**
   * Per-provider descriptor snapshot, captured at `plugin add` from the module's
   * declared `ProviderModule.descriptor` merged with what could be derived from
   * the loaded module. Keyed by provider name.
   *
   * Snapshotting is what lets every consumer — the CLI's sync `open --targets`
   * probe, the hub's hot `listProviders` path — resolve capabilities WITHOUT an
   * `import()` of an external package. Absent on a v1 record; back-filled the
   * first time something loads the module anyway.
   */
  descriptors?: Record<string, ProviderDescriptor>;
  /** `SDK_API_VERSION` the package declared (compat gate). */
  apiVersion: number;
  /** ISO timestamp the package was added. */
  addedAt: string;
}

/**
 * v2 added `PluginRecord.descriptors`. A v1 file is read as-is and upgraded in
 * place on the next write — the field is optional, so nothing breaks in between.
 */
export type PluginsFileVersion = 1 | 2;

export interface PluginsFile {
  version: PluginsFileVersion;
  plugins: PluginRecord[];
}

export const PLUGINS_FILE_VERSION = 2;

const EMPTY: PluginsFile = { version: PLUGINS_FILE_VERSION, plugins: [] };

function isKnownVersion(v: unknown): v is PluginsFileVersion {
  return v === 1 || v === 2;
}

const LOCK_STALE_MS = 15_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 20_000;
const LOCK_RETRY_MS = 25;

/** Exclusive cross-process lock around `${path}.lock` (mirrors state.ts). */
async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.writeFile(`${String(process.pid)}\n`);
      await fh.close();
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) break;
      await delay(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await rm(lockPath, { force: true }).catch(() => {});
  }
}

function normalize(raw: unknown): PluginsFile {
  const parsed = raw as PluginsFile;
  if (!parsed || !isKnownVersion(parsed.version) || !Array.isArray(parsed.plugins)) {
    // Unrecognized shape → treat as empty (a fresh registry), never throw:
    // a corrupt plugins.json must not brick every CLI command.
    return { ...EMPTY };
  }
  return parsed;
}

/** Synchronous read for the CLI's sync name-list / validation checks. Missing file → empty. */
export function readPluginRegistrySync(path: string = PLUGINS_FILE): PluginsFile {
  try {
    if (!existsSync(path)) return { ...EMPTY };
    return normalize(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { ...EMPTY };
  }
}

export async function readPluginRegistry(path: string = PLUGINS_FILE): Promise<PluginsFile> {
  try {
    return normalize(JSON.parse(await readFile(path, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    return { ...EMPTY };
  }
}

/**
 * Read for a read-modify-WRITE. Unlike the lenient readers (which degrade a
 * corrupt file to empty so the CLI never bricks), this REFUSES to proceed when
 * an existing file is unparseable/unrecognized — otherwise `addPluginRecord`
 * would overwrite a recoverable `plugins.json` and silently drop every other
 * registered plugin. A genuinely missing file (ENOENT) is still an empty start.
 */
async function readForWrite(path: string): Promise<PluginsFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `refusing to modify a corrupt plugin registry at ${path} (${(err as Error).message}) — fix or delete the file and retry.`,
    );
  }
  const p = parsed as PluginsFile;
  if (!p || !isKnownVersion(p.version) || !Array.isArray(p.plugins)) {
    throw new Error(
      `refusing to modify an unrecognized plugin registry at ${path} — fix or delete the file and retry.`,
    );
  }
  return p;
}

async function writeRegistry(file: PluginsFile, path: string = PLUGINS_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  // Any write upgrades a v1 file: the added field is optional, so an older CLI
  // reading the result still sees every record it understands.
  const out: PluginsFile = { ...file, version: PLUGINS_FILE_VERSION };
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

/**
 * Record a descriptor snapshot for one provider of an already-registered
 * package (the back-fill path for a v1 record, or a plugin that declared none).
 * A no-op when the package isn't registered — losing a snapshot only costs the
 * next caller another derivation, so this must never throw into a hot path.
 */
export async function recordPluginDescriptor(
  providerName: string,
  descriptor: ProviderDescriptor,
  path: string = PLUGINS_FILE,
): Promise<void> {
  await withFileLock(path, async () => {
    const file = await readForWrite(path);
    const rec = file.plugins.find((p) => p.providers.includes(providerName));
    if (!rec) return;
    rec.descriptors = { ...rec.descriptors, [providerName]: descriptor };
    await writeRegistry(file, path);
  });
}

/** Upsert a plugin by `packageName` (idempotent re-add updates the record). */
export async function addPluginRecord(
  record: PluginRecord,
  path: string = PLUGINS_FILE,
): Promise<void> {
  await withFileLock(path, async () => {
    const file = await readForWrite(path);
    const next = file.plugins.filter((p) => p.packageName !== record.packageName);
    next.push(record);
    await writeRegistry({ version: PLUGINS_FILE_VERSION, plugins: next }, path);
  });
}

/**
 * Remove a plugin by package name OR by a provider name it contributes.
 * Returns the removed record(s) count.
 */
export async function removePluginRecord(
  nameOrPackage: string,
  path: string = PLUGINS_FILE,
): Promise<number> {
  let removed = 0;
  await withFileLock(path, async () => {
    const file = await readForWrite(path);
    const next = file.plugins.filter((p) => {
      const match = p.packageName === nameOrPackage || p.providers.includes(nameOrPackage);
      if (match) removed += 1;
      return !match;
    });
    await writeRegistry({ version: PLUGINS_FILE_VERSION, plugins: next }, path);
  });
  return removed;
}

/** All provider names contributed by registered plugins (sync). */
export function pluginProviderNames(path: string = PLUGINS_FILE): string[] {
  return readPluginRegistrySync(path).plugins.flatMap((p) => p.providers);
}

/** The plugin record that contributes `providerName`, or null (sync). */
export function pluginForProvider(
  providerName: string,
  path: string = PLUGINS_FILE,
): PluginRecord | null {
  return (
    readPluginRegistrySync(path).plugins.find((p) => p.providers.includes(providerName)) ?? null
  );
}
