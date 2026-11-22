/**
 * The PC side of `agentbox memory`: which repo a folder is, and where this PC's
 * agent keeps that repo's memory. Pure path work plus `git`; the data itself
 * always comes from the hub.
 */
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { repoKey, tryGetMachineId } from '@agentbox/config';
import { hostMemoryDir, safeMemoryPath } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

/** The git toplevel of `cwd` (the folder claude keys a project by), canonicalised. */
export async function projectFolder(cwd: string): Promise<string> {
  const r = await execa('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { reject: false });
  const top = r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : resolve(cwd);
  return realpath(top).catch(() => top);
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
  action: 'add' | 'update' | 'same';
  version: number;
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
