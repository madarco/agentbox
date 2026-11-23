/**
 * The PC side of `agentbox memory`: which repo a folder is, and where this PC's
 * agent keeps that repo's memory. Pure path work plus `git`; the data itself
 * always comes from the hub.
 */
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { STATE_DIR, repoKey, tryGetMachineId } from '@agentbox/config';
import { hostMemoryDir, safeMemoryPath } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

/** The git toplevel of `cwd` (the folder claude keys a project by), canonicalised; null outside a checkout. */
export async function gitToplevel(cwd: string): Promise<string | null> {
  const r = await execa('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { reject: false });
  const top = r.exitCode === 0 ? r.stdout.trim() : '';
  if (!top) return null;
  return realpath(top).catch(() => top);
}

/** The git toplevel of `cwd`, or `cwd` itself outside a checkout (for read-only lookups). */
export async function projectFolder(cwd: string): Promise<string> {
  return (await gitToplevel(cwd)) ?? resolve(cwd);
}

/**
 * The repo a folder's memory is keyed by: its `origin` remote, else (no remote)
 * this machine's local key, which is what the relay keys such a box by.
 */
export async function repoOfFolder(folder: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', folder, 'remote', 'get-url', 'origin'], { reject: false });
  const origin = r.exitCode === 0 ? r.stdout.trim() : '';
  const machineId = tryGetMachineId() ?? undefined;
  if (origin) return repoKey(origin, { machineId });
  return machineId ? `local:${machineId}:${folder}` : undefined;
}

/** This PC's memory dir for `agent` and the project in `folder`. */
export function localMemoryDir(agent: string, folder: string, home: string = homedir()): string {
  const spec = resolveAgentSpec(agent);
  const mem = spec.history?.memory?.[0];
  const rel = spec.staticPaths[0]?.hostHomeRel;
  if (!mem || !rel) throw new Error(`agent '${agent}' declares no memory`);
  return hostMemoryDir(join(home, ...rel), mem, folder);
}

/** Regular files under `dir` (relative path → bytes); symlinks are not followed. */
export async function readLocalMemory(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(abs, name)).catch(() => null);
      if (st?.isDirectory()) await walk(join(abs, name), r);
      else if (st?.isFile()) out.set(r, await readFile(join(abs, name)));
    }
  };
  await walk(dir, '');
  return out;
}

export interface PullPlanEntry {
  path: string;
  /**
   * `add`/`update`: the hub's live version differs from (or is missing on) the PC.
   * `delete`: the hub's latest version is a tombstone and the PC still has the file.
   * `local`: on the PC only, never on the hub; never touched.
   */
  action: 'add' | 'update' | 'same' | 'delete' | 'local';
  version: number;
  /** The hub's bytes, for `add`/`update`. */
  bytes?: Buffer;
}

/**
 * What a pull would do. `hubFiles` is the hub's latest version of every path,
 * tombstones included; `fetch` reads one live version's bytes.
 */
export async function planPull(
  hubFiles: Array<{ path: string; version: number; deleted: boolean }>,
  local: Map<string, Buffer>,
  fetch: (path: string, version: number) => Promise<Buffer>,
): Promise<PullPlanEntry[]> {
  const out: PullPlanEntry[] = [];
  const seen = new Set<string>();
  for (const f of hubFiles) {
    if (!safeMemoryPath(f.path)) continue;
    seen.add(f.path);
    const have = local.get(f.path);
    if (f.deleted) {
      if (have) out.push({ path: f.path, action: 'delete', version: f.version });
      continue;
    }
    const bytes = await fetch(f.path, f.version);
    const action = !have ? 'add' : have.equals(bytes) ? 'same' : 'update';
    out.push({ path: f.path, action, version: f.version, ...(action === 'same' ? {} : { bytes }) });
  }
  for (const p of local.keys())
    if (!seen.has(p)) out.push({ path: p, action: 'local', version: 0 });
  return out;
}

/**
 * Copy the PC files a pull is about to overwrite or delete to
 * `~/.agentbox/memory-backups/<agent>/<projectKey>/<stamp>/`, outside the agent's
 * memory dir so the agent never reads them. Returns the backup dir, or null.
 */
export async function backupMemoryFiles(
  dir: string,
  paths: string[],
  agent: string,
  stamp: string = new Date().toISOString().replace(/[:.]/g, '-'),
  root: string = join(STATE_DIR, 'memory-backups'),
): Promise<string | null> {
  if (paths.length === 0) return null;
  const projectKey =
    dir
      .replace(/\/memory\/?$/, '')
      .split('/')
      .pop() ?? 'project';
  const dest = join(root, agent, projectKey, stamp);
  for (const p of paths) {
    const safe = safeMemoryPath(p);
    if (!safe) continue;
    await mkdir(dirname(join(dest, safe)), { recursive: true });
    await copyFile(join(dir, safe), join(dest, safe));
  }
  return dest;
}

/** Write `bytes` at `dir/path` atomically. The path was checked by the caller. */
export async function writeMemoryFile(dir: string, path: string, bytes: Buffer): Promise<void> {
  const safe = safeMemoryPath(path);
  if (!safe) throw new Error(`refusing memory path ${path}`);
  const target = join(dir, safe);
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.agentbox-part`;
  await writeFile(part, bytes);
  await rename(part, target);
}
