// Materialize box sessions where the agents look (docs/usage-dashboard-plan.md,
// Phase 4a): write each box claude session the hub holds into this PC's
// `~/.claude/projects/<host project key>/`, so the host's claude lists it in
// `/resume` like its own. Written from `history.db` (the redacted copy, one
// source), rewritten only when the hub's copy changed, and written again when it
// is missing, which includes claude's own `cleanupPeriodDays` deleting it.
//
// A file at the target that the materializer did not write, or that changed
// after it wrote it (the host's claude resumed the session and appended), is
// never touched: the first is a session id collision, logged once.
import { link, mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  hostProjectKey,
  safeMemoryPath,
  type AgentHistorySpec,
  type AgentHistoryTranscripts,
} from '@agentbox/core';
import {
  listProjectsConfigured,
  loadEffectiveConfig,
  repoKey,
  tryGetMachineId,
} from '@agentbox/config';
import {
  BOX_PROJECT_KEY,
  MATERIALIZED_FILE,
  listCheckouts,
  readMaterialized,
  writeMaterialized,
  type MaterializedEntry,
  type MaterializedManifest,
} from '@agentbox/relay';
import { AGENT_SYNC_SPECS, readState } from '@agentbox/sandbox-core';
import type { HistoryFileRow, HistoryService, HistorySessionRow } from './history';

/** Agents whose box sessions are written to the PC. Codex, opencode and pi: backlog. */
export const MATERIALIZED_AGENTS: readonly string[] = ['claude'];

/** After a ship, wait this long for more frames of the same session before writing. */
export const MATERIALIZE_DEBOUNCE_MS = 15_000;
/** The full pass: re-creates what claude's cleanup deleted. */
export const MATERIALIZE_PASS_MS = 24 * 60 * 60_000;
const FIRST_PASS_MS = 60_000;

export interface MaterializeTarget {
  agent: string;
  /** The agent's config dir on this PC (`~/.claude`). */
  hostConfigDir: string;
  transcripts: AgentHistoryTranscripts[];
}

/** The agents' host config dirs and their keyed transcript roots. */
export function materializeTargets(
  home: string = homedir(),
  agents: readonly string[] = MATERIALIZED_AGENTS,
): MaterializeTarget[] {
  const out: MaterializeTarget[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    if (!agents.includes(spec.id)) continue;
    const rel = spec.staticPaths[0]?.hostHomeRel;
    const history: AgentHistorySpec | undefined = spec.history;
    if (!history || !rel) continue;
    const transcripts = history.transcripts.filter((t) => t.mode === 'append' && t.hostKey);
    if (transcripts.length === 0) continue;
    out.push({ agent: spec.id, hostConfigDir: join(home, ...rel), transcripts });
  }
  return out;
}

/**
 * Where a box file (`projects/-workspace/<id>.jsonl`, relative to the agent's
 * config dir in the box) goes on this PC for project folder `folder`, or null
 * when its path is not under a keyed transcript root.
 */
export function hostPathFor(
  target: MaterializeTarget,
  boxPath: string,
  folder: string,
): string | null {
  for (const t of target.transcripts) {
    if (!t.hostKey) continue;
    const boxRoot = `${t.root.replaceAll('<projectKey>', BOX_PROJECT_KEY)}/`;
    if (!boxPath.startsWith(boxRoot)) continue;
    const rest = safeMemoryPath(boxPath.slice(boxRoot.length));
    if (!rest || !rest.endsWith('.jsonl')) return null;
    const hostRoot = t.root.replaceAll('<projectKey>', hostProjectKey(t.hostKey, folder));
    return join(target.hostConfigDir, hostRoot, rest);
  }
  return null;
}

/**
 * The folders on this machine a session's project may live in, best first: its
 * box's project folder (a box this hub created), this machine's checkouts of the
 * session's repo, then registered projects with that origin. The caller takes
 * the first that exists.
 */
export async function hostFoldersOf(session: HistorySessionRow): Promise<string[]> {
  const out: string[] = [];
  if (session.boxId) {
    const box = (await readState().catch(() => ({ boxes: [] }))).boxes.find(
      (b) => b.id === session.boxId,
    );
    if (box?.projectRoot) out.push(box.projectRoot);
  }
  const key = repoKey(session.projectRepoUrl);
  if (key) {
    const me = tryGetMachineId();
    if (me) {
      for (const c of await listCheckouts({ repoKey: key, machineId: me }).catch(() => [])) {
        out.push(c.folder);
      }
    }
    for (const p of await listProjectsConfigured().catch(() => [])) {
      if (p.originUrl && repoKey(p.originUrl) === key) out.push(p.originalPath);
    }
  }
  return [...new Set(out)];
}

/** The first of `hostFoldersOf` that is a folder here. */
export async function hostFolderOf(session: HistorySessionRow): Promise<string | null> {
  for (const f of await hostFoldersOf(session)) if (await folderExists(f)) return f;
  return null;
}

const ENABLED_TTL_MS = 60_000;
const enabledCache = new Map<string, { at: number; value: boolean }>();

/** `history.materialize` for a project folder (its config over the global one). */
export async function materializeEnabled(folder: string): Promise<boolean> {
  const hit = enabledCache.get(folder);
  if (hit && Date.now() - hit.at < ENABLED_TTL_MS) return hit.value;
  let value = true;
  try {
    value = (await loadEffectiveConfig(folder)).effective.history.materialize !== false;
  } catch {
    /* unreadable config: keep the default (on) */
  }
  enabledCache.set(folder, { at: Date.now(), value });
  return value;
}

export interface MaterializeDeps {
  history: Pick<HistoryService, 'repo' | 'rawStream' | 'onSessionUpdated'>;
  /** The session's project folder on this machine, or null (default `hostFolderOf`). */
  folderOf?(session: HistorySessionRow): Promise<string | null>;
  /** `history.materialize` for that folder (default `materializeEnabled`). */
  enabled?(folder: string): Promise<boolean>;
  log(line: string): void;
  /** Tests: the home the agent config dirs are under, and the manifest file. */
  home?: string;
  manifestFile?: string;
  debounceMs?: number;
}

export interface MaterializeStats {
  sessions: number;
  written: number;
  skipped: number;
}

export interface SessionMaterializer {
  /** Write one session's files where needed. Serialized with every other call. */
  session(key: string): Promise<MaterializeStats>;
  /** Every box session of a materialized agent. */
  pass(): Promise<MaterializeStats>;
  start(): void;
  stop(): void;
}

async function folderExists(folder: string): Promise<boolean> {
  const s = await stat(folder).catch(() => null);
  return s?.isDirectory() === true;
}

export function createSessionMaterializer(deps: MaterializeDeps): SessionMaterializer {
  const targets = new Map(materializeTargets(deps.home).map((t) => [t.agent, t]));
  const manifestFile = deps.manifestFile ?? MATERIALIZED_FILE;
  // Logged once per path per hub run, not once per pass.
  const warned = new Set<string>();
  const warnOnce = (path: string, line: string): void => {
    if (warned.has(path)) return;
    warned.add(path);
    deps.log(line);
  };

  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const sameAsWritten = (
    s: { size: number; mtimeMs: number; ino?: number },
    e: MaterializedEntry | undefined,
  ): boolean =>
    !!e &&
    s.size === e.size &&
    Math.trunc(s.mtimeMs) === Math.trunc(e.mtimeMs) &&
    (e.ino === undefined || s.ino === undefined || s.ino === e.ino);

  /** One file to write, decided before anything is written. */
  interface Job {
    session: HistorySessionRow;
    file: HistoryFileRow;
    path: string;
    /** The manifest entry before this run (undefined: none). */
    before: MaterializedEntry | undefined;
    /** `new`: nothing on disk; `rewrite`: our copy of other bytes; `append`: our copy, grown. */
    mode: 'new' | 'rewrite' | 'append';
  }

  /**
   * The job for one host path, or null. Two hub files of one session can map to
   * the same path (a box resuming another box's session on the shared docker
   * volume, a file named after another session): one of them owns the path, the
   * manifest's if it is still there, else the longest, and the others are skipped,
   * so the copy is not rewritten by each in turn.
   */
  async function plan(
    manifest: MaterializedManifest,
    session: HistorySessionRow,
    candidates: HistoryFileRow[],
    path: string,
  ): Promise<Job | null> {
    const before = manifest.files[path];
    if (before && before.session !== session.key) {
      warnOnce(
        path,
        `history: materialize: ${path} belongs to ${before.session}; ${session.key} not written there`,
      );
      return null;
    }
    const file =
      candidates.find((f) => f.id === before?.fileId) ??
      [...candidates].sort((a, b) => b.offset - a.offset || a.id - b.id)[0]!;
    const onDisk = await stat(path).catch(() => null);
    if (!onDisk) return { session, file, path, before, mode: 'new' };
    if (!before) {
      warnOnce(
        path,
        `history: materialize: ${path} exists and was not written by the hub (session id collision with ${session.key}); left alone`,
      );
      return null;
    }
    if (!sameAsWritten(onDisk, before)) {
      warnOnce(
        path,
        `history: materialize: ${path} changed on this PC since the hub wrote it; left alone`,
      );
      return null;
    }
    const sameBytes = before.fileId === file.id && before.generation === file.generation;
    if (sameBytes && before.offset === file.offset) return null;
    return { session, file, path, before, mode: sameBytes ? 'append' : 'rewrite' };
  }

  /**
   * Stream the file into a fresh `fh` without holding it in memory, keeping
   * complete lines only (a final flush can ship a line the box was still
   * writing). Returns the bytes kept; the file is cut there.
   */
  async function streamLines(fh: FileHandle, file: HistoryFileRow): Promise<number> {
    let written = 0;
    let lastLine = 0;
    for await (const b of deps.history.rawStream(file.id, file.offset)) {
      await fh.write(b);
      const nl = b.lastIndexOf(0x0a);
      if (nl >= 0) lastLine = written + nl + 1;
      written += b.length;
    }
    if (lastLine < written) await fh.truncate(lastLine);
    return lastLine;
  }

  /** Write one job's copy. `true` when it landed. */
  async function execute(manifest: MaterializedManifest, job: Job): Promise<boolean> {
    const { file, path, before } = job;
    const undo = (why: string): false => {
      if (before) manifest.files[path] = before;
      else delete manifest.files[path];
      warnOnce(path, `history: materialize: ${path} ${why}; left alone`);
      return false;
    };
    const record = (st: { size: number; mtimeMs: number; ino: number }): true => {
      manifest.files[path] = {
        session: job.session.key,
        fileId: file.id,
        generation: file.generation,
        offset: file.offset,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ino: st.ino,
      };
      return true;
    };

    if (job.mode === 'append') {
      // Only the bytes past the copy, read from the chunk that holds them: the
      // growth since the last write, so it is held in memory.
      const parts: Buffer[] = [];
      for await (const c of deps.history.rawStream(file.id, file.offset, before!.size))
        parts.push(c);
      const raw = Buffer.concat(parts);
      const bytes = raw.subarray(0, raw.lastIndexOf(0x0a) + 1);
      if (bytes.length === 0) return false;
      // O_APPEND: never over bytes someone else added. The window to the host's
      // claude is the one write, checked on the handle right before and after.
      const fh = await open(path, 'a');
      try {
        const pre = await fh.stat();
        if (!sameAsWritten(pre, before))
          return undo('changed on this PC while the hub was writing it');
        await fh.write(bytes);
        const post = await fh.stat();
        if (post.size !== pre.size + bytes.length) {
          // Written alongside: recorded as it would have been, so the next pass
          // sees the difference and leaves the copy alone.
          manifest.files[path] = { ...before!, size: pre.size + bytes.length, mtimeMs: -1 };
          warnOnce(
            path,
            `history: materialize: ${path} was written on this PC during an append; left alone from now on`,
          );
          return false;
        }
        return record(post);
      } finally {
        await fh.close();
      }
    }

    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${String(file.id)}.agentbox-materialize.tmp`);
    try {
      const fh = await open(tmp, 'w', 0o600);
      let kept: number;
      try {
        kept = await streamLines(fh, file);
      } finally {
        await fh.close();
      }
      if (kept === 0) return undo('has no complete line yet');
      if (job.mode === 'new') {
        // `link` fails when the path exists: a copy the host's claude created
        // since the plan is never replaced.
        try {
          await link(tmp, path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST')
            return undo('appeared while the hub was writing it');
          throw e;
        }
      } else {
        const now = await stat(path).catch(() => null);
        if (!now || !sameAsWritten(now, before))
          return undo('changed on this PC while the hub was writing it');
        await rename(tmp, path);
      }
      return record(await stat(path));
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async function plansFor(
    manifest: MaterializedManifest,
    key: string,
    stats: MaterializeStats,
    folders: Map<string, Promise<string | null>>,
  ): Promise<Job[]> {
    const session = await deps.history.repo.getSession(key);
    if (!session?.boxId) return []; // host sessions are already on their PC
    const target = targets.get(session.agent);
    if (!target) return [];
    // One lookup per box and repo per run: a pass walks every session.
    const memo = `${session.boxId}\0${session.projectRepoUrl ?? ''}`;
    let found = folders.get(memo);
    if (!found) {
      found = (deps.folderOf ?? hostFolderOf)(session);
      folders.set(memo, found);
    }
    const folder = await found;
    if (!folder || !(await folderExists(folder))) return [];
    if (!(await (deps.enabled ?? materializeEnabled)(folder))) return [];
    stats.sessions++;
    const byPath = new Map<string, HistoryFileRow[]>();
    for (const file of await deps.history.repo.filesOfSession(key)) {
      if (file.offset === 0) continue;
      const path = hostPathFor(target, file.path, folder);
      if (!path) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), file]);
    }
    const jobs: Job[] = [];
    for (const [path, files] of byPath) {
      const job = await plan(manifest, session, files, path);
      if (job) jobs.push(job);
      else stats.skipped++;
    }
    return jobs;
  }

  /**
   * Forget entries whose hub file is gone (purged by retention) and whose copy
   * is gone too. A copy still on disk keeps its entry: the host-session watcher
   * must go on skipping it.
   */
  async function prune(manifest: MaterializedManifest): Promise<boolean> {
    let changed = false;
    for (const [path, e] of Object.entries(manifest.files)) {
      if (await stat(path).catch(() => null)) continue;
      if (await deps.history.repo.getFileById(e.fileId)) continue;
      delete manifest.files[path];
      changed = true;
    }
    return changed;
  }

  async function run(
    keys: () => Promise<string[]>,
    opts: { prune?: boolean } = {},
  ): Promise<MaterializeStats> {
    const stats: MaterializeStats = { sessions: 0, written: 0, skipped: 0 };
    const manifest = await readMaterialized(manifestFile);
    const folders = new Map<string, Promise<string | null>>();
    const jobs: Job[] = [];
    const claimed = new Set<string>();
    for (const key of await keys()) {
      try {
        for (const job of await plansFor(manifest, key, stats, folders)) {
          if (claimed.has(job.path)) continue;
          claimed.add(job.path);
          jobs.push(job);
        }
      } catch (e) {
        deps.log(`history: materialize ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let changed = opts.prune ? await prune(manifest) : false;
    if (jobs.length > 0) {
      // Listed before any copy lands (one manifest write per run), so the
      // host-session watcher never sees an unlisted copy. An entry that does not
      // match the file after a crash makes the copy "changed on this PC": left
      // alone, and still never shipped as a host session.
      for (const j of jobs) {
        manifest.files[j.path] = j.before
          ? { ...j.before }
          : {
              session: j.session.key,
              fileId: j.file.id,
              generation: j.file.generation,
              offset: j.file.offset,
              size: 0,
              mtimeMs: -1,
            };
      }
      await writeMaterialized(manifest, manifestFile);
      for (const j of jobs) {
        try {
          if (await execute(manifest, j)) stats.written++;
          else stats.skipped++;
        } catch (e) {
          stats.skipped++;
          if (j.before) manifest.files[j.path] = j.before;
          else delete manifest.files[j.path];
          deps.log(
            `history: materialize ${j.session.key} to ${j.path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      changed = true;
    }
    if (changed) await writeMaterialized(manifest, manifestFile);
    return stats;
  }

  const pending = new Map<string, NodeJS.Timeout>();
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | null = null;

  const m: SessionMaterializer = {
    session: (key) => serialized(() => run(() => Promise.resolve([key]))),

    pass: () =>
      serialized(() =>
        run(
          async () =>
            (await deps.history.repo.listSessions())
              .filter((s) => s.boxId && targets.has(s.agent))
              .map((s) => s.key),
          { prune: true },
        ),
      ),

    start() {
      unsubscribe = deps.history.onSessionUpdated((key, boxId) => {
        if (!boxId || !targets.has(key.slice(0, key.indexOf(':')))) return;
        // A turn ships as several frames: write once they have settled.
        const prev = pending.get(key);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
          pending.delete(key);
          m.session(key).catch((e: unknown) =>
            deps.log(`history: materialize ${key}: ${e instanceof Error ? e.message : String(e)}`),
          );
        }, deps.debounceMs ?? MATERIALIZE_DEBOUNCE_MS);
        t.unref();
        pending.set(key, t);
      });
      const pass = (): void => {
        m.pass().then(
          (r) => {
            if (r.written > 0)
              deps.log(
                `history: materialized ${String(r.written)} box session file(s) into the agents' folders`,
              );
          },
          (e: unknown) =>
            deps.log(`history: materialize pass: ${e instanceof Error ? e.message : String(e)}`),
        );
      };
      const first = setTimeout(pass, FIRST_PASS_MS);
      const daily = setInterval(pass, MATERIALIZE_PASS_MS);
      first.unref();
      daily.unref();
      timers.push(first, daily);
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      for (const t of timers.splice(0)) clearTimeout(t);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
  return m;
}
