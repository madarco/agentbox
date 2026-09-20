import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from './state.js';

/**
 * On-disk surface of a manager's pty-host: one unix socket, one meta file.
 *
 * Deliberately flat and outside the workspace dir. The host is discovered by a
 * directory scan (it outlives the hub that spawned it, so there is no in-memory
 * registry to consult after a hub restart), and a unix socket path has to stay
 * well inside macOS's 104-byte `sun_path` limit — which a workspace-nested path
 * would not guarantee.
 */
export function ptyDir(baseDir: string = STATE_DIR): string {
  return join(baseDir, 'pty');
}

export function ptySocketPath(managerId: string, baseDir: string = STATE_DIR): string {
  return join(ptyDir(baseDir), `${managerId}.sock`);
}

export function ptyMetaPath(managerId: string, baseDir: string = STATE_DIR): string {
  return join(ptyDir(baseDir), `${managerId}.json`);
}

export function ptyLogPath(managerId: string, baseDir: string = STATE_DIR): string {
  return join(baseDir, 'logs', `pty-${managerId}.log`);
}

export interface PtySessionMeta {
  v: 1;
  managerId: string;
  workspaceId: string;
  agent: string;
  cwd: string;
  socket: string;
  /** pid of the pty-host process, not of the agent inside it. */
  pid: number;
  /** Guards against a recycled pid claiming a live session. */
  pidStartedAt?: string;
  startedAt: string;
  /** Presented by every client in `hello`; a socket alone is not authorization. */
  token: string;
  /** Proves to `detect` that a session really is this manager's. */
  runId: string;
  cols: number;
  rows: number;
  pinned: boolean;
  leaseGraceMs: number;
  exitCode?: number;
  exitedAt?: string;
}

export function newPtyToken(): string {
  return randomBytes(32).toString('hex');
}

export function newPtyRunId(): string {
  return randomBytes(16).toString('hex');
}

/** 0700 so another account on a shared machine cannot even enumerate sessions. */
export async function ensurePtyDir(baseDir: string = STATE_DIR): Promise<string> {
  const dir = ptyDir(baseDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

export async function writePtyMeta(
  meta: PtySessionMeta,
  baseDir: string = STATE_DIR,
): Promise<void> {
  await ensurePtyDir(baseDir);
  const path = ptyMetaPath(meta.managerId, baseDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function readPtyMeta(
  managerId: string,
  baseDir: string = STATE_DIR,
): Promise<PtySessionMeta | undefined> {
  try {
    const raw = await readFile(ptyMetaPath(managerId, baseDir), 'utf8');
    const parsed = JSON.parse(raw) as PtySessionMeta;
    return parsed.v === 1 && typeof parsed.managerId === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function listPtySessions(baseDir: string = STATE_DIR): Promise<PtySessionMeta[]> {
  let names: string[];
  try {
    names = await readdir(ptyDir(baseDir));
  } catch {
    return [];
  }
  const out: PtySessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const meta = await readPtyMeta(name.slice(0, -'.json'.length), baseDir);
    if (meta) out.push(meta);
  }
  return out;
}

/** Drops both files. Safe to call for a session that is already gone. */
export async function removePtySession(
  managerId: string,
  baseDir: string = STATE_DIR,
): Promise<void> {
  await Promise.all([
    rm(ptySocketPath(managerId, baseDir), { force: true }),
    rm(ptyMetaPath(managerId, baseDir), { force: true }),
  ]);
}
