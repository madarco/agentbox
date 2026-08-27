/**
 * The outbox: where a box's `cp toHost` waits when the machine it is addressed
 * to is offline.
 *
 * The read direction has a cache to fall back on; the write direction has
 * nowhere to fall back to — the destination is a disk that is not currently
 * reachable. Failing outright would mean an agent's build artifact, diff or log
 * is simply lost because a laptop was shut. So the control box pulls the bytes
 * out of the box while it still can, parks them in custody with their intended
 * destination, and the machine lands them (behind the usual approval) the next
 * time it connects.
 *
 * The box is told plainly that this happened, with a non-zero exit: the copy it
 * asked for has NOT landed yet, and reporting success would be a lie an agent
 * would build on.
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CustodyStore } from './custody/store.js';
import type { HostActionResult } from './types.js';

/** Sidecar for one parked outbound copy. */
export interface CpOutboxMeta {
  id: string;
  boxId: string;
  boxName: string;
  /** Destination exactly as the box asked for it — resolved on the target machine. */
  dest: string;
  /** Box-side sources, for the approval message. */
  sources: string[];
  createdAt: string;
  size: number;
}

/** A parked item as the draining machine sees it. */
export interface CpOutboxItem {
  meta: CpOutboxMeta;
  /** Custody path of the tar. */
  tarPath: string;
  /** Custody path of the sidecar. */
  metaPath: string;
}

const PULL_TIMEOUT_MS = 300_000;
const TAR_TIMEOUT_MS = 120_000;

/** Custody prefix for a project's outbox. Mirrors {@link cpCachePrefix}'s shape. */
export function cpOutboxPrefix(opts: { projectSlug?: string; boxId: string }): string {
  const slug = (opts.projectSlug ?? '').trim();
  return slug.length > 0 ? `projects/${slug}/cp-out` : `boxes/${opts.boxId}/cp-out`;
}

/** True for a custody path that is an outbox sidecar (the listing's filter). */
export function isCpOutboxMetaPath(path: string): boolean {
  return /\/cp-out\/[A-Za-z0-9-]+\.json$/.test(path);
}

/** Every parked item currently in custody, newest first. */
export async function listCpOutbox(custody: CustodyStore): Promise<CpOutboxItem[]> {
  const out: CpOutboxItem[] = [];
  for (const entry of await custody.list()) {
    if (!isCpOutboxMetaPath(entry.path)) continue;
    const found = await custody.get(entry.path);
    if (!found) continue;
    try {
      const meta = JSON.parse(found.data.toString('utf8')) as CpOutboxMeta;
      if (!meta || typeof meta.id !== 'string' || typeof meta.dest !== 'string') continue;
      out.push({
        meta,
        metaPath: entry.path,
        tarPath: entry.path.replace(/\.json$/, '.tar'),
      });
    } catch {
      /* a corrupt sidecar is not an item; the sweep below will not touch it */
    }
  }
  return out.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : -1));
}

/** Drop one parked item (both halves). Safe to call twice. */
export async function removeCpOutboxItem(custody: CustodyStore, item: CpOutboxItem): Promise<void> {
  await custody.delete(item.tarPath).catch(() => false);
  await custody.delete(item.metaPath).catch(() => false);
}

export interface ParkCpOutboxDeps {
  custody: CustodyStore | null | undefined;
  cliEntry: string | undefined;
  boxId: string;
  boxName: string;
  prefix: string;
  maxBytes: number;
  log?: (line: string) => void;
}

/**
 * Pull `sources` out of the box and park them for the offline machine.
 *
 * Returns the result the box gets. Any failure here degrades to a plain
 * "machine offline" answer from the caller — the bytes were never on the target
 * disk, so nothing is lost by not parking them.
 */
export async function parkCpOutbox(
  sources: string[],
  dest: string,
  deps: ParkCpOutboxDeps,
): Promise<HostActionResult | null> {
  const log = deps.log ?? ((): void => {});
  if (!deps.custody || !deps.cliEntry) return null;
  let workDir: string | undefined;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'agentbox-cp-outbox-'));
    workDir = dir;
    const stage = join(dir, 'payload');
    await run('mkdir', ['-p', stage], TAR_TIMEOUT_MS);
    // Pull with the same CLI a live copy uses; cwd is this fresh dir, so the
    // deleted-workspace crash that started all of this cannot recur here.
    for (const src of sources) {
      await runNode(
        [deps.cliEntry, 'cp', `${deps.boxName}:${src}`, stage, '--yes'],
        dir,
        PULL_TIMEOUT_MS,
      );
    }
    const names = await readdir(stage);
    if (names.length === 0) return null;
    const tarPath = join(dir, 'outbox.tar');
    await run('tar', ['-cf', tarPath, '-C', stage, ...names], TAR_TIMEOUT_MS);
    const info = await stat(tarPath);
    if (info.size > deps.maxBytes) {
      log(`cp outbox: ${String(info.size)} bytes exceeds the ${String(deps.maxBytes)}-byte limit`);
      return null;
    }
    const id = randomUUID();
    const meta: CpOutboxMeta = {
      id,
      boxId: deps.boxId,
      boxName: deps.boxName,
      dest,
      sources,
      createdAt: new Date().toISOString(),
      size: info.size,
    };
    await deps.custody.putStream(`${deps.prefix}/${id}.tar`, createReadStream(tarPath), {
      maxBytes: deps.maxBytes,
    });
    await deps.custody.put(`${deps.prefix}/${id}.json`, Buffer.from(JSON.stringify(meta), 'utf8'));
    log(`cp outbox: parked ${String(names.length)} path(s) from ${deps.boxName} for ${dest}`);
    return {
      // 75 = EX_TEMPFAIL: accepted, not yet delivered. A zero here would tell an
      // agent the file is on the user's disk when it is still in transit.
      exitCode: 75,
      stdout: '',
      stderr:
        `the machine these files are addressed to is offline, so they are parked on the hub.\n` +
        `It will land them at ${dest} — behind the usual approval — the next time it connects.\n`,
    };
  } catch (err) {
    log(`cp outbox: could not park: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Land one parked item at `destAbs`, following the same rules a live `cp` does:
 *
 * - a destination that exists as a directory, or was written with a trailing
 *   slash, receives the tar's members under their own names;
 * - otherwise the destination NAMES the file, so a single member is renamed onto
 *   it (`cp toHost /workspace/report.md ./out/summary.md` must produce
 *   `summary.md`, not `report.md`).
 *
 * The naive "strip to the parent directory" version silently did the first thing
 * in both cases, so a renaming copy landed under the wrong name and a copy into
 * `./out` (no slash) landed one level too high.
 */
export async function landCpOutboxTar(
  tarFile: string,
  destAbs: string,
  opts: { destEndsWithSlash: boolean },
): Promise<void> {
  const asDirectory =
    opts.destEndsWithSlash || (existsSync(destAbs) && (await stat(destAbs)).isDirectory());
  if (asDirectory) {
    await run('mkdir', ['-p', destAbs], TAR_TIMEOUT_MS);
    await run('tar', ['-xf', tarFile, '-C', destAbs], TAR_TIMEOUT_MS);
    return;
  }
  // Unpack aside so the member's own name never appears at the destination.
  const staging = await mkdtemp(join(tmpdir(), 'agentbox-cp-land-'));
  try {
    await run('tar', ['-xf', tarFile, '-C', staging], TAR_TIMEOUT_MS);
    const members = await readdir(staging);
    await run('mkdir', ['-p', dirname(destAbs)], TAR_TIMEOUT_MS);
    if (members.length === 1) {
      await rm(destAbs, { recursive: true, force: true });
      await rename(join(staging, members[0]!), destAbs);
      return;
    }
    // Several members cannot share one filename; the destination is the
    // directory they belong in, which is also what `cp a b dir/` means.
    await run('mkdir', ['-p', destAbs], TAR_TIMEOUT_MS);
    for (const m of members) {
      await rm(join(destAbs, m), { recursive: true, force: true });
      await rename(join(staging, m), join(destAbs, m));
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Write a readable to a temp file and return its path (caller removes the dir). */
export async function stageOutboxTar(
  data: NodeJS.ReadableStream,
): Promise<{ dir: string; tarPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-cp-land-'));
  const tarPath = join(dir, 'payload.tar');
  await pipeline(data, createWriteStream(tarPath));
  return { dir, tarPath };
}

function run(bin: string, args: string[], timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(bin, args, { timeout }, (err) => (err ? reject(err) : resolve()));
  });
}

function runNode(argv: string[], cwd: string, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(process.execPath, argv, { cwd, timeout }, (err) => (err ? reject(err) : resolve()));
  });
}
