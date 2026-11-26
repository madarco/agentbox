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
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
    s: { size: number; mtimeMs: number },
    e: MaterializedEntry | undefined,
  ): boolean => !!e && s.size === e.size && Math.trunc(s.mtimeMs) === Math.trunc(e.mtimeMs);

  async function writeFileCopy(
    manifest: MaterializedManifest,
    session: HistorySessionRow,
    file: HistoryFileRow,
    path: string,
  ): Promise<'written' | 'skipped'> {
    const entry = manifest.files[path];
    const onDisk = await stat(path).catch(() => null);
    if (onDisk) {
      if (!entry) {
        warnOnce(
          path,
          `history: materialize: ${path} exists and was not written by the hub (session id collision with ${session.key}); left alone`,
        );
        return 'skipped';
      }
      if (!sameAsWritten(onDisk, entry)) {
        warnOnce(
          path,
          `history: materialize: ${path} changed on this PC since the hub wrote it; left alone`,
        );
        return 'skipped';
      }
      if (
        entry.fileId === file.id &&
        entry.generation === file.generation &&
        entry.offset === file.offset
      ) {
        return 'skipped';
      }
    }
    // Our copy of the same bytes, and the hub's file only grew: append the new
    // lines instead of rewriting the session.
    const appendFrom =
      onDisk &&
      entry &&
      entry.fileId === file.id &&
      entry.generation === file.generation &&
      file.offset > entry.size
        ? entry.size
        : 0;
    const parts: Buffer[] = [];
    let pos = 0;
    for await (const b of deps.history.rawStream(file.id, file.offset)) {
      const from = Math.max(0, appendFrom - pos);
      if (from < b.length) parts.push(b.subarray(from));
      pos += b.length;
    }
    const raw = Buffer.concat(parts);
    // Complete lines only: a final flush can ship a line the box was still writing.
    const end = raw.lastIndexOf(0x0a) + 1;
    if (end === 0) return 'skipped';
    const bytes = raw.subarray(0, end);

    // Listed before the file lands, so the host-session watcher never sees an
    // unlisted copy. A crash before the final stat leaves an entry that no
    // longer matches the file: it is then left alone, and still never shipped.
    manifest.files[path] = {
      session: session.key,
      fileId: file.id,
      generation: file.generation,
      offset: file.offset,
      size: appendFrom + end,
      mtimeMs: -1,
    };
    await writeMaterialized(manifest, manifestFile);
    const undo = async (why: string): Promise<'skipped'> => {
      if (entry) manifest.files[path] = entry;
      else delete manifest.files[path];
      await writeMaterialized(manifest, manifestFile);
      warnOnce(path, `history: materialize: ${path} ${why}; left alone`);
      return 'skipped';
    };
    // Re-checked right before the write: the host's claude may have created or
    // resumed it meanwhile.
    const stillOurs = async (): Promise<boolean> => {
      const now = await stat(path).catch(() => null);
      return now ? sameAsWritten(now, entry) : !entry || !onDisk;
    };
    if (appendFrom > 0) {
      if (!(await stillOurs())) return undo('changed on this PC while the hub was writing it');
      await appendFile(path, bytes);
    } else {
      await mkdir(dirname(path), { recursive: true });
      const tmp = join(dirname(path), `.${String(file.id)}.agentbox-materialize.tmp`);
      try {
        await writeFile(tmp, bytes, { mode: 0o600 });
        if (!(await stillOurs()))
          return await undo('appeared or changed while the hub was writing it');
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    }
    const written = await stat(path);
    manifest.files[path] = {
      ...manifest.files[path]!,
      size: written.size,
      mtimeMs: written.mtimeMs,
    };
    await writeMaterialized(manifest, manifestFile);
    return 'written';
  }

  async function doSession(
    manifest: MaterializedManifest,
    key: string,
    stats: MaterializeStats,
    folders: Map<string, Promise<string | null>>,
  ): Promise<void> {
    const session = await deps.history.repo.getSession(key);
    if (!session?.boxId) return; // host sessions are already on their PC
    const target = targets.get(session.agent);
    if (!target) return;
    // One lookup per box and repo per run: a pass walks every session.
    const memo = `${session.boxId}\0${session.projectRepoUrl ?? ''}`;
    let found = folders.get(memo);
    if (!found) {
      found = (deps.folderOf ?? hostFolderOf)(session);
      folders.set(memo, found);
    }
    const folder = await found;
    if (!folder || !(await folderExists(folder))) return;
    if (!(await (deps.enabled ?? materializeEnabled)(folder))) return;
    stats.sessions++;
    for (const file of await deps.history.repo.filesOfSession(key)) {
      if (file.offset === 0) continue;
      const path = hostPathFor(target, file.path, folder);
      if (!path) continue;
      try {
        if ((await writeFileCopy(manifest, session, file, path)) === 'written') stats.written++;
        else stats.skipped++;
      } catch (e) {
        stats.skipped++;
        deps.log(
          `history: materialize ${key} to ${path}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  async function run(keys: () => Promise<string[]>): Promise<MaterializeStats> {
    const stats: MaterializeStats = { sessions: 0, written: 0, skipped: 0 };
    const manifest = await readMaterialized(manifestFile);
    const folders = new Map<string, Promise<string | null>>();
    for (const key of await keys()) {
      try {
        await doSession(manifest, key, stats, folders);
      } catch (e) {
        deps.log(`history: materialize ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return stats;
  }

  const pending = new Map<string, NodeJS.Timeout>();
  const timers: NodeJS.Timeout[] = [];
  let unsubscribe: (() => void) | null = null;

  const m: SessionMaterializer = {
    session: (key) => serialized(() => run(() => Promise.resolve([key]))),

    pass: () =>
      serialized(() =>
        run(async () =>
          (await deps.history.repo.listSessions())
            .filter((s) => s.boxId && targets.has(s.agent))
            .map((s) => s.key),
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
