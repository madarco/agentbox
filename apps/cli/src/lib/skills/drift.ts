/**
 * The "skills not in sync" notice: after a create that doesn't attach, a queued
 * `-i` run and `agentbox queue list`, one line names this PC's skills that
 * differ from the hub's library. A box only gets the hub's copy, so a skill
 * added or edited on the PC after the first seed is otherwise missing from
 * every new box without a word (an orchestrating agent polling the queue is the
 * reader this is for).
 *
 * Same definition as `agentbox skills`: `compareSkills` + `isOutOfSync`, so a
 * skill marked skipped never counts. A PC skill that can't be uploaded as is
 * (secret-scan hits, bad frontmatter, over `skills.maxSkillBytes`) is not
 * counted either, since syncing can't fix it; it is named once instead.
 * Best-effort and bounded: any failure (no hub, an error, a timeout) is one
 * debug line and no notice.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '@clack/prompts';
import { loadEffectiveConfig, STATE_DIR } from '@agentbox/config';
import {
  discoverLocalSkills,
  isOutOfSync,
  uploadBlocker,
  type LocalSkill,
  type SkillHashCache,
  type SkillHashEntry,
} from '@agentbox/sandbox-core';
import { hostReachable } from '@agentbox/sandbox-cloud';
import { HubApiClient, type HubApiSkillsListing } from '../../control-plane/hub-api-client.js';
import { compareSkills } from './sync.js';

export interface SkillsDrift {
  outOfSync: number;
  /** Every out-of-sync name, sorted. */
  names: string[];
  localOnly: string[];
  changed: string[];
  hubOnly: string[];
  /** On the PC, not in sync, and not uploadable as is: never in `outOfSync`. */
  unuploadable: string[];
}

/** The `--json` shape. */
export interface SkillsDriftJson {
  outOfSync: number;
  names: string[];
  unuploadable: string[];
}

const DEFAULT_TIMEOUT_MS = 2000;
/** How many names one notice lists before "+N more". */
const MAX_NAMED = 5;

/**
 * Compare this PC's skills with the hub's library. Null when the notice is off,
 * this PC has no skills, or the hub can't answer within the budget; a drift
 * with `outOfSync: 0` when everything is in sync.
 */
export async function checkSkillsDrift(
  opts: {
    /** The hub to compare against; default the configured one. */
    url?: string;
    /** This PC's skills when the caller already scanned them. */
    local?: LocalSkill[];
    /** Why there is no answer (a log file, never the terminal). */
    debug?: (line: string) => void;
    /** Budget for the whole hub leg: resolving the target and the one request. */
    timeoutMs?: number;
    /**
     * Reuse an answer (or a failure) this young for the same hub and the same
     * local skills: a poll loop (`agentbox queue`) then asks the hub at most once
     * per window, and an unreachable hub costs it the budget once, not every poll.
     */
    cacheTtlMs?: number;
    cwd?: string;
  } = {},
): Promise<SkillsDrift | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const cfg = await loadEffectiveConfig(opts.cwd ?? process.cwd()).catch(() => null);
    if (cfg && !cfg.effective.skills.notice) return null;
    const maxBytes = cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024;
    const ttl = opts.cacheTtlMs;
    // Without a cache the hub leg starts alongside the local scan (the two don't
    // depend on each other); with one, the scan comes first because it is half
    // of the cache key, and a hit costs no network at all.
    let hub = ttl === undefined ? startHubLeg(opts.url, timeoutMs) : null;
    const local = opts.local ?? (await scanWithCache(maxBytes));
    if (local.length === 0) {
      opts.debug?.('skills notice skipped: no skills on this PC');
      return null;
    }
    let key = '';
    if (ttl !== undefined) {
      key = driftCacheKey(opts.url ?? cfg?.effective.relay.controlPlaneUrl ?? '', local);
      const hit = await readDriftCache(key, ttl);
      if (hit !== undefined) return hit;
    }
    hub ??= startHubLeg(opts.url, timeoutMs);
    const res = await hub;
    let drift: SkillsDrift | null = null;
    if (res === 'timeout') {
      opts.debug?.(`skills notice skipped: no answer from the hub within ${String(timeoutMs)}ms`);
    } else if (res === null) {
      opts.debug?.('skills notice skipped: no hub could be resolved');
    } else if ('error' in res) {
      opts.debug?.(`skills notice skipped: ${res.error}`);
    } else {
      drift = driftFromRows(compareSkills(local, res.listing.skills, res.listing.skipped ?? []));
    }
    if (ttl !== undefined) await writeDriftCache(key, drift);
    return drift;
  } catch (err) {
    opts.debug?.(`skills notice skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}

type HubLeg = { listing: HubApiSkillsListing } | { error: string } | null | 'timeout';

/**
 * Resolve the hub and ask it for its library, all inside `timeoutMs`: the abort
 * timer starts before the resolve, so a slow resolve leaves the request less
 * time rather than a fresh budget. No session header: finding the calling agent
 * shells out to `ps` synchronously, which a read of the library doesn't need
 * and which would hold the event loop (and this deadline) hostage.
 */
function startHubLeg(url: string | undefined, timeoutMs: number): Promise<HubLeg> {
  const ctrl = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve('timeout');
    }, timeoutMs);
    timer.unref();
  });
  const work = (async (): Promise<HubLeg> => {
    try {
      // Lazy, like autoSeedSkills: control-plane.ts sits in a module cycle with hub.ts.
      const { resolveHubApiTarget } = await import('../../commands/control-plane.js');
      const target = await resolveHubApiTarget(url, { quiet: true });
      if (!target) return null;
      // A remote hub is probed with a socket we can destroy first: an aborted
      // fetch still leaves undici's connecting socket open until its own ~10 s
      // connect timeout, which kept the CLI process alive long after the notice
      // gave up. Loopback never hangs a connect (a closed port refuses at once).
      if (!isLoopback(target.url)) {
        const left = deadlineAt - Date.now();
        if (left <= 0 || !(await hostReachable(target.url, left))) {
          return { error: `hub at ${target.url} is unreachable` };
        }
      }
      const client = new HubApiClient({ ...target, session: null, sessionTurn: null });
      return { listing: await client.listSkills({ signal: ctrl.signal }) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })();
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * File hashes (and scan hits) from the last check, so a poll only stats this
 * PC's skills instead of reading and hashing every file: 120 MB of skills cost
 * 1.5 s to hash and a few ms to stat. Keyed by path + size + mtime, so a file
 * rewritten with both kept (`touch -r`, `cp -p`, `rsync -a`) reads as
 * unchanged until its next real edit: acceptable, since only this notice reads
 * the cache.
 */
const HASH_CACHE_VERSION = 2;
type HashRow = [size: number, mtimeMs: number, sha256: string, findings?: [string, number][]];

function hashCachePath(): string {
  return join(STATE_DIR, 'skills-hash-cache.json');
}

/** Write via a temp file and a rename; the temp file never outlives a failure. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch {
    // Best-effort: the next check recomputes.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function scanWithCache(maxBytes: number): Promise<LocalSkill[]> {
  let prev: Record<string, HashRow> = {};
  try {
    const doc = JSON.parse(await readFile(hashCachePath(), 'utf8')) as {
      version?: unknown;
      files?: Record<string, HashRow>;
    };
    if (doc.version === HASH_CACHE_VERSION && doc.files) prev = doc.files;
  } catch {
    /* no cache yet, or unreadable: a full scan rebuilds it */
  }
  const next: Record<string, HashRow> = {};
  let changed = false;
  const hashCache: SkillHashCache = {
    get(path, size, mtimeMs): SkillHashEntry | undefined {
      const e = prev[path];
      if (!e || e[0] !== size || e[1] !== mtimeMs) return undefined;
      return { sha256: e[2], findings: (e[3] ?? []).map(([rule, line]) => ({ rule, line })) };
    },
    set(path, size, mtimeMs, entry) {
      const e = prev[path];
      if (!e || e[0] !== size || e[1] !== mtimeMs || e[2] !== entry.sha256) changed = true;
      next[path] =
        entry.findings.length > 0
          ? [size, mtimeMs, entry.sha256, entry.findings.map((f) => [f.rule, f.line])]
          : [size, mtimeMs, entry.sha256];
    },
  };
  const local = await discoverLocalSkills({ home: homedir(), maxBytes, hashCache });
  // Entries for files that are gone are dropped by writing only what was seen.
  if (changed || Object.keys(prev).length !== Object.keys(next).length) {
    await writeAtomic(
      hashCachePath(),
      JSON.stringify({ version: HASH_CACHE_VERSION, files: next }),
    );
  }
  return local;
}

/** The answer `agentbox queue` reuses between polls (see `cacheTtlMs`). */
function driftCachePath(): string {
  return join(STATE_DIR, 'skills-drift-cache.json');
}

/** Which hub, and what this PC holds: a change to either is a miss. */
function driftCacheKey(hub: string, local: readonly LocalSkill[]): string {
  const h = createHash('sha256').update(`${hub}\n`);
  for (const s of [...local].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`${s.name} ${s.treeSha} ${uploadBlocker(s) ? 1 : 0}\n`);
  }
  return h.digest('hex');
}

/** The cached answer (null = "no answer" cached too), or undefined on a miss. */
async function readDriftCache(key: string, ttlMs: number): Promise<SkillsDrift | null | undefined> {
  try {
    const doc = JSON.parse(await readFile(driftCachePath(), 'utf8')) as {
      key?: unknown;
      at?: unknown;
      drift?: SkillsDrift | null;
    };
    if (doc.key !== key || typeof doc.at !== 'number') return undefined;
    const age = Date.now() - doc.at;
    if (age < 0 || age >= ttlMs) return undefined;
    return doc.drift ?? null;
  } catch {
    return undefined;
  }
}

async function writeDriftCache(key: string, drift: SkillsDrift | null): Promise<void> {
  await writeAtomic(driftCachePath(), JSON.stringify({ key, at: Date.now(), drift }));
}

export function driftFromRows(
  rows: readonly {
    name: string;
    status: string;
    local?: Pick<LocalSkill, 'problems' | 'findings'>;
  }[],
): SkillsDrift {
  const out = rows.filter((r) => isOutOfSync(r.status));
  // Only a PC copy can be unuploadable; a hub-only skill is fixed by a download.
  const blocked = (r: (typeof out)[number]): boolean =>
    r.status !== 'hub-only' && r.local !== undefined && uploadBlocker(r.local) !== null;
  const counted = out.filter((r) => !blocked(r));
  const pick = (status: string): string[] =>
    counted
      .filter((r) => r.status === status)
      .map((r) => r.name)
      .sort();
  return {
    outOfSync: counted.length,
    names: counted.map((r) => r.name).sort(),
    localOnly: pick('local-only'),
    changed: pick('differs'),
    hubOnly: pick('hub-only'),
    unuploadable: out
      .filter(blocked)
      .map((r) => r.name)
      .sort(),
  };
}

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED);
  const more = names.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` +${String(more)} more` : '');
}

/**
 * The one notice line; null when there is nothing to say. `newUnuploadable`:
 * the unuploadable names not announced yet (each is named once, not on every
 * poll; see {@link takeNewUnuploadable}).
 */
export function describeDrift(
  d: SkillsDrift,
  newUnuploadable: readonly string[] = [],
): string | null {
  const blocked =
    newUnuploadable.length > 0
      ? `${String(newUnuploadable.length)} can't be uploaded as is (${nameList(newUnuploadable)}); see \`agentbox skills\``
      : '';
  if (d.outOfSync === 0) {
    return blocked
      ? `skills: ${blocked}. Boxes get the hub's copy, so they won't have these.`
      : null;
  }
  let budget = MAX_NAMED;
  const groups: string[] = [];
  for (const [label, names] of [
    ['on this PC only', d.localOnly],
    ['changed', d.changed],
    ['on the hub only', d.hubOnly],
  ] as const) {
    if (names.length === 0 || budget === 0) continue;
    const shown = names.slice(0, budget);
    budget -= shown.length;
    groups.push(`${label}: ${shown.join(', ')}`);
  }
  const more = d.outOfSync - (MAX_NAMED - budget);
  const detail = groups.join('; ') + (more > 0 ? `; +${String(more)} more` : '');
  return (
    `skills: ${String(d.outOfSync)} not in sync with the hub (${detail}). ` +
    "Boxes get the hub's copy. Run `agentbox skills` to sync." +
    (blocked ? ` Also ${blocked}.` : '')
  );
}

export function driftJson(d: SkillsDrift | null): SkillsDriftJson | null {
  return d ? { outOfSync: d.outOfSync, names: d.names, unuploadable: d.unuploadable } : null;
}

/** The unuploadable names last announced. */
function announcedPath(): string {
  return join(STATE_DIR, 'skills-notice-announced.json');
}

/**
 * The unuploadable names not announced before, recording the current set: one
 * that stays unuploadable is named once, not on every create and poll; one
 * fixed and later broken again is named again.
 */
export function takeNewUnuploadable(current: readonly string[]): string[] {
  let seen: string[] = [];
  try {
    const doc = JSON.parse(readFileSync(announcedPath(), 'utf8')) as { unuploadable?: unknown };
    if (Array.isArray(doc.unuploadable)) {
      seen = doc.unuploadable.filter((n): n is string => typeof n === 'string');
    }
  } catch {
    /* nothing announced yet */
  }
  const fresh = current.filter((n) => !seen.includes(n));
  if (fresh.length > 0 || seen.length !== current.length) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(announcedPath(), JSON.stringify({ unuploadable: [...current] }) + '\n');
    } catch {
      /* best-effort: worst case a name is announced again */
    }
  }
  return fresh;
}

/**
 * Print the notice: the CLI's warning style on a terminal, one plain stderr line
 * otherwise, so a script parsing stdout is untouched while an orchestrating
 * agent (which reads both) still sees it.
 */
export function printSkillsNotice(d: SkillsDrift | null): void {
  if (!d) return;
  const line = describeDrift(d, takeNewUnuploadable(d.unuploadable));
  if (!line) return;
  if (process.stdout.isTTY) log.warn(line);
  else process.stderr.write(line + '\n');
}
