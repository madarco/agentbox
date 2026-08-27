/**
 * The control box's half of the cp cache: answering `cp fromHost` from stored
 * bytes when the machine that owns the files is not connected.
 *
 * Two rules shape this, both about not lying to an agent:
 *
 * 1. **All or nothing.** A multi-source copy that finds three of four entries
 *    fails rather than delivering a partial set, because the box has no way to
 *    tell which of its files is missing and would proceed as if it had them all.
 * 2. **Always say it is cached, and from when.** The result stdout carries the
 *    age of every entry. An agent reading a config file has to be able to tell
 *    "this is live" from "this is what your laptop looked like on Tuesday".
 */

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CustodyStore } from './custody/store.js';
import {
  cpCacheMetaPath,
  cpCacheTarPath,
  describeCacheAge,
  parseCpCacheMeta,
  type CpCacheMeta,
} from './cp-cache.js';
import { normalizeCpParams } from './cp-rpc.js';
import type { CpRpcParams, HostActionResult } from './types.js';

const UNTAR_TIMEOUT_MS = 120_000;
const CP_TIMEOUT_MS = 300_000;

export interface CpCacheServeDeps {
  custody: CustodyStore | null | undefined;
  /** `AGENTBOX_CLI_ENTRY` — the CLI this hub shells for the box-side copy. */
  cliEntry: string | undefined;
  boxName: string;
  cachePrefix: string;
  log?: (line: string) => void;
}

/**
 * What the cache can offer for a request, without moving any bytes: used to
 * decide whether to bother asking the user to approve a cached copy.
 */
export interface CpCacheLookup {
  /** Resolved absolute host path → its stored metadata. */
  entries: { sourcePath: string; meta: CpCacheMeta }[];
  /** Sources with no cached entry. Non-empty ⇒ the cache cannot serve this. */
  missing: string[];
}

/** Which of `sources` (already resolved to absolute host paths) the cache holds. */
export async function lookupCpCache(
  sources: string[],
  deps: Pick<CpCacheServeDeps, 'custody' | 'cachePrefix'>,
): Promise<CpCacheLookup> {
  const entries: { sourcePath: string; meta: CpCacheMeta }[] = [];
  const missing: string[] = [];
  if (!deps.custody) return { entries, missing: [...sources] };
  for (const sourcePath of sources) {
    const metaRaw = await deps.custody.get(cpCacheMetaPath(deps.cachePrefix, sourcePath));
    const meta = metaRaw ? parseCpCacheMeta(metaRaw.data.toString('utf8')) : null;
    const tar = await deps.custody.stat(cpCacheTarPath(deps.cachePrefix, sourcePath));
    if (!meta || !tar) missing.push(sourcePath);
    else entries.push({ sourcePath, meta });
  }
  return { entries, missing };
}

/** One line per entry, so the age is visible in both the approval and the box. */
export function describeCpCacheEntries(lookup: CpCacheLookup, now: number = Date.now()): string {
  return lookup.entries
    .map(
      // The path it was captured FROM on the owning machine, not the box's
      // spelling of it: the person approving is being asked about their own disk.
      (e) => `  ${e.meta.sourcePath} (${describeCacheAge(e.meta.capturedAt, now)})`,
    )
    .join('\n');
}

/**
 * Unpack the cached entries and deliver them into the box, by shelling the same
 * `agentbox cp` a live copy would use — only the source moves. cwd is the temp
 * dir we just created, which is also why this path cannot reproduce the missing-
 * cwd crash that made cp fail on a control box in the first place.
 */
export async function serveCpFromCache(
  params: CpRpcParams | undefined,
  resolved: string[],
  deps: CpCacheServeDeps,
): Promise<HostActionResult> {
  const log = deps.log ?? ((): void => {});
  if (!deps.cliEntry) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'relay: AGENTBOX_CLI_ENTRY not set; cannot deliver the cached copy\n',
    };
  }
  const { dest } = normalizeCpParams('cp.fromHost', params);
  const lookup = await lookupCpCache(resolved, deps);
  if (lookup.missing.length > 0 || !deps.custody) {
    return { exitCode: 69, stdout: '', stderr: '' };
  }
  let workDir: string | undefined;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'agentbox-cp-serve-'));
    workDir = dir;
    const names: string[] = [];
    for (const entry of lookup.entries) {
      const found = await deps.custody.getStream(
        cpCacheTarPath(deps.cachePrefix, entry.sourcePath),
      );
      if (!found) return { exitCode: 69, stdout: '', stderr: '' };
      const tarPath = join(dir, `${names.length.toString()}.tar`);
      await pipeline(found.data, createWriteStream(tarPath));
      await run('tar', ['-xf', tarPath, '-C', dir], UNTAR_TIMEOUT_MS);
      await rm(tarPath, { force: true });
      names.push(basename(entry.sourcePath));
    }
    const argv = [
      deps.cliEntry,
      'cp',
      ...names.map((n) => join(dir, n)),
      `${deps.boxName}:${dest}`,
      '--yes',
    ];
    const out = await runCapture(process.execPath, argv, dir, CP_TIMEOUT_MS);
    if (out.exitCode !== 0) return out;
    const age = describeCpCacheEntries(lookup);
    log(`cp cache: served ${String(lookup.entries.length)} entr(y|ies) for ${deps.boxName}`);
    return {
      exitCode: 0,
      // The provenance goes in stdout, where the agent that asked will read it —
      // a cached file that looks live is worse than no file.
      stdout:
        `${out.stdout.trimEnd()}\n` +
        `NOTE: served from the hub's cache — the machine holding these files is offline.\n${age}\n`,
      stderr: out.stderr,
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `serving the cached copy failed: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(bin: string, args: string[], timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(bin, args, { timeout }, (err) => (err ? reject(err) : resolve()));
  });
}

function runCapture(
  bin: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<HostActionResult> {
  return new Promise<HostActionResult>((resolve) => {
    execFile(bin, args, { cwd, timeout }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err
            ? 1
            : 0;
      resolve({ exitCode: code, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
