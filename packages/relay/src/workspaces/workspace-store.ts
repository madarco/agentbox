import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { basename, join } from 'node:path';
import {
  hashProjectPath,
  listProjectsConfigured,
  registerProject,
  sanitizeMnemonic,
  withFileLock,
  type ProjectEntry,
} from '@agentbox/config';
import { normalizeRepoUrl } from './timeline-pr.js';
import {
  WORKSPACES_DIR,
  type Workspace,
  type WorkspaceHost,
  type WorkspaceProject,
  type WorkspaceRecord,
} from './types.js';

/**
 * Short lock windows: these files sit on the hub's dashboard poll path, so a
 * lock left by a killed process must not hold a read for the default 15s. The
 * write itself is atomic (temp+rename), so the worst case of proceeding without
 * the lock is a lost update, never a corrupt file. Mirrors META_LOCK in
 * @agentbox/config's project-meta writer, for the same reason.
 */
export const WORKSPACE_LOCK = { staleMs: 2_000, acquireTimeoutMs: 5_000 };

/** Directory names never scanned for projects. */
const SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor']);

/** 16 lowercase hex, the manager-id shape: a workspace outlives every folder holding it. */
export function newWorkspaceId(): string {
  return randomBytes(8).toString('hex');
}

/** The on-disk dir for a workspace. The mnemonic suffix is decorative. */
export function workspaceDir(id: string, root?: string): string {
  return join(WORKSPACES_DIR, root ? `${id}-${sanitizeMnemonic(basename(root))}` : id);
}

export function workspaceFile(dir: string): string {
  return join(dir, 'workspace.json');
}

export function tasksFile(dir: string): string {
  return join(dir, 'tasks.json');
}

export function timelineFile(dir: string): string {
  return join(dir, 'timeline.jsonl');
}

export function managersFile(dir: string): string {
  return join(dir, 'managers.json');
}

/** Where a hub-run manager's shell records the agent's exit code. */
export function managerExitFile(dir: string, managerId: string): string {
  return join(dir, 'managers', `${managerId}.exit`);
}

/** The single-manager files an earlier layout wrote; read once, then removed. */
export function legacyManagerFiles(dir: string): { rec: string; exit: string } {
  return { rec: join(dir, 'manager.json'), exit: join(dir, 'manager.exit') };
}

/**
 * Resolve the dir holding a workspace by id. The dir name carries a decorative
 * mnemonic we cannot reconstruct from the id alone (the root may be gone), so
 * this scans for the entry whose leading 16 hex chars match — the same rule
 * `listProjectsConfigured` uses for the project registry.
 */
export async function resolveWorkspaceDir(id: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(WORKSPACES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  for (const name of entries) {
    const m = /^([0-9a-f]{16})(?:-.+)?$/.exec(name);
    if (m && m[1] === id) return join(WORKSPACES_DIR, name);
  }
  return null;
}

/** Absolute, no trailing slash. */
function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Absolute, realpath'd, no trailing slash — the canonical spelling of a folder. */
export async function canonicalWorkspaceRoot(absPath: string): Promise<string> {
  const resolved = await realpath(absPath).catch(() => absPath);
  return stripTrailingSlash(resolved);
}

/** Does this folder look like a project root (what a box would be built from)? */
async function looksLikeProject(dir: string): Promise<boolean> {
  const [git, yaml] = await Promise.all([
    stat(join(dir, '.git')).catch(() => null),
    stat(join(dir, 'agentbox.yaml')).catch(() => null),
  ]);
  // `.git` is a directory in a normal clone and a FILE in a worktree/submodule,
  // so presence is the test, not its type.
  return git !== null || yaml !== null;
}

/**
 * Project roots inside a workspace: the folder itself when it is one, plus every
 * immediate subfolder that is. Depth 1 only — a deeper walk would pick up
 * vendored checkouts and fixture repos, and a monorepo's packages are one
 * project, not many.
 *
 * Runs on the machine holding the folders: the CLI scans and posts the result,
 * so a hub that never saw the folder registers the same workspace.
 */
export async function scanWorkspaceProjects(root: string): Promise<string[]> {
  const out: string[] = [];
  if (await looksLikeProject(root)) out.push(root);
  let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const subs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.') || SCAN_SKIP.has(e.name)) continue;
    const dir = join(root, e.name);
    if (await looksLikeProject(dir)) subs.push(dir);
  }
  subs.sort((a, b) => a.localeCompare(b));
  out.push(...subs);
  return out;
}

/**
 * The id of one project. A repo is the same project on every machine, so its id
 * is its normalised remote; a project with no remote exists only where its
 * folder is, so its id carries the host.
 */
export function workspaceProjectId(host: string, path: string, repoUrl?: string): string {
  const repo = normalizeRepoUrl(repoUrl);
  return hashProjectPath(repo ?? `${host}:${stripTrailingSlash(path)}`);
}

/** This machine's folder for a workspace, when it has one. */
export function workspaceRootOn(
  rec: Pick<WorkspaceRecord, 'hosts'>,
  host: string,
): string | undefined {
  return rec.hosts[host]?.root;
}

/** This machine's project folders for a workspace, in record order. */
export function workspaceProjectRootsOn(
  rec: Pick<WorkspaceRecord, 'projects' | 'hosts'>,
  host: string,
): string[] {
  const map = rec.hosts[host]?.projectRoots ?? {};
  const ordered = rec.projects.map((p) => map[p.id]).filter((p): p is string => Boolean(p));
  // A mapping for a project the record no longer lists is still a folder on this
  // machine; keeping it makes the read total rather than silently short.
  const extra = Object.entries(map)
    .filter(([id]) => !rec.projects.some((p) => p.id === id))
    .map(([, path]) => path);
  return [...ordered, ...extra];
}

// ── migration ──

/** A version-less record, as the folder-keyed layout wrote it. */
interface WorkspaceRecordV1 {
  id: string;
  name: string;
  root: string;
  projectIds: string[];
  taskCounter: number;
  createdAt: string;
  updatedAt: string;
}

function isV1(raw: unknown): raw is WorkspaceRecordV1 {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !('version' in raw) &&
    typeof (raw as { root?: unknown }).root === 'string'
  );
}

/**
 * Upgrade a folder-keyed record in memory. The workspace id is KEPT — its tasks,
 * managers and timeline are stored under it — and the folders come back from the
 * project registry, which recorded each project's path and origin when the
 * workspace registered it. A project the registry no longer knows is dropped:
 * its folder is unrecoverable from a path hash, and the next `workspace add`
 * re-discovers it.
 */
export function upgradeWorkspaceRecord(
  raw: WorkspaceRecordV1,
  host: string,
  projects: readonly Pick<ProjectEntry, 'hash' | 'originalPath' | 'originUrl'>[],
): WorkspaceRecord {
  const known = new Map(projects.map((p) => [p.hash, p]));
  const out: WorkspaceProject[] = [];
  const projectRoots: Record<string, string> = {};
  for (const oldId of raw.projectIds) {
    const entry = known.get(oldId);
    if (!entry) continue;
    const id = workspaceProjectId(host, entry.originalPath, entry.originUrl);
    if (!out.some((p) => p.id === id)) {
      out.push({
        id,
        name: basename(entry.originalPath),
        ...(entry.originUrl ? { repoUrl: entry.originUrl } : {}),
      });
    }
    projectRoots[id] = entry.originalPath;
  }
  return {
    version: 2,
    id: raw.id,
    name: raw.name,
    projects: out,
    hosts: { [host]: { root: raw.root, projectRoots, seenAt: raw.updatedAt } },
    taskCounter: raw.taskCounter,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Parse one stored record, upgrading a version-less one. `registry` is resolved
 * once per read of many records — the upgrade is the only reader of it, and the
 * common case has nothing to upgrade.
 */
async function parseRecord(
  raw: string,
  host: string,
  registry: () => Promise<ProjectEntry[]>,
): Promise<WorkspaceRecord | null> {
  const parsed = JSON.parse(raw) as unknown;
  if (isV1(parsed)) return upgradeWorkspaceRecord(parsed, host, await registry());
  const rec = parsed as WorkspaceRecord;
  return rec.version === 2 && typeof rec.id === 'string' ? rec : null;
}

/** `listProjectsConfigured`, resolved at most once per read. */
function registryOnce(): () => Promise<ProjectEntry[]> {
  let pending: Promise<ProjectEntry[]> | undefined;
  return () => (pending ??= listProjectsConfigured().catch(() => []));
}

export async function readWorkspace(id: string): Promise<WorkspaceRecord | null> {
  const dir = await resolveWorkspaceDir(id);
  if (!dir) return null;
  try {
    const raw = await readFile(workspaceFile(dir), 'utf8');
    return await parseRecord(raw, osHostname(), registryOnce());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null; // malformed: treat as absent, like loadQueue's skip
  }
}

/** Every registered workspace. Malformed entries are skipped, never thrown on. */
export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(WORKSPACES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const host = osHostname();
  const registry = registryOnce();
  const out: WorkspaceRecord[] = [];
  for (const name of entries) {
    if (!/^[0-9a-f]{16}(?:-.+)?$/.test(name)) continue;
    try {
      const raw = await readFile(workspaceFile(join(WORKSPACES_DIR, name)), 'utf8');
      const rec = await parseRecord(raw, host, registry);
      if (rec) out.push(rec);
    } catch {
      // skip malformed / partially-created
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function writeWorkspace(rec: WorkspaceRecord): Promise<void> {
  const mnemonic = workspaceRootOn(rec, osHostname()) ?? Object.values(rec.hosts)[0]?.root;
  const dir = (await resolveWorkspaceDir(rec.id)) ?? workspaceDir(rec.id, mnemonic);
  await mkdir(dir, { recursive: true });
  const final = workspaceFile(dir);
  const tmp = `${final}.tmp.${String(process.pid)}.${Date.now().toString(36)}`;
  await writeFile(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  await rename(tmp, final);
}

/** Locked read-modify-write of one workspace record. */
export async function updateWorkspace(
  id: string,
  fn: (rec: WorkspaceRecord) => WorkspaceRecord | Promise<WorkspaceRecord>,
): Promise<WorkspaceRecord | null> {
  const dir = await resolveWorkspaceDir(id);
  if (!dir) return null;
  return withFileLock(
    workspaceFile(dir),
    async () => {
      const current = await readWorkspace(id);
      if (!current) return null;
      const next = { ...(await fn(current)), updatedAt: new Date().toISOString() };
      await writeWorkspace(next);
      return next;
    },
    WORKSPACE_LOCK,
  );
}

export interface AddWorkspaceDeps {
  /** Seam so a test registers nothing in the real project registry. */
  register?: (absPath: string) => Promise<void>;
  /** The hub's own hostname; only its own folders reach the project registry. */
  hostname?: () => string;
  /** Seam for the id of a new record. */
  newId?: () => string;
}

/** One project as the scanning machine found it. */
export interface WorkspaceProjectInput {
  /** Absolute path on `host`. */
  path: string;
  name?: string;
  repoUrl?: string;
}

export interface AddWorkspaceInput {
  /** `os.hostname()` of the machine that scanned these folders. */
  host: string;
  /** Absolute folder on `host`. */
  root: string;
  name?: string;
  projects: WorkspaceProjectInput[];
  /** Update this record; without it the match is by (host, root), then by repo. */
  id?: string;
}

/**
 * The workspace an add refers to: the id it named, else the record already
 * mapping this (host, root), else one sharing a repo with it. Repo last, so two
 * folders on one machine holding the same repos stay two workspaces unless the
 * client says otherwise.
 */
function matchWorkspace(
  records: WorkspaceRecord[],
  input: { id?: string; host: string; root: string },
  projects: readonly WorkspaceProject[],
): WorkspaceRecord | undefined {
  if (input.id) return records.find((r) => r.id === input.id);
  const byRoot = records.find((r) => r.hosts[input.host]?.root === input.root);
  if (byRoot) return byRoot;
  const repos = new Set(
    projects.map((p) => normalizeRepoUrl(p.repoUrl)).filter((r): r is string => Boolean(r)),
  );
  if (repos.size === 0) return undefined;
  return records.find((r) =>
    r.projects.some((p) => {
      const repo = normalizeRepoUrl(p.repoUrl);
      return repo !== undefined && repos.has(repo);
    }),
  );
}

/**
 * Register (or refresh) a workspace from a scan another machine may have run.
 * Idempotent: re-posting the same folder rescans it, and a second machine
 * posting its own checkout of the same repos merges its mapping into the record
 * rather than creating a rival workspace.
 *
 * Every project folder ON THIS HUB'S OWN MACHINE is registered in the PROJECT
 * registry too, so it appears in `GET /projects` and can host a box without a
 * second step. Another host's folders are not this hub's to register.
 */
export async function addWorkspace(
  input: AddWorkspaceInput,
  deps: AddWorkspaceDeps = {},
): Promise<WorkspaceRecord> {
  const register = deps.register ?? ((p: string) => registerProject(p));
  const localHost = (deps.hostname ?? osHostname)();
  const root = stripTrailingSlash(input.root);
  const scanned = input.projects.map((p) => {
    const path = stripTrailingSlash(p.path);
    return {
      path,
      project: {
        id: workspaceProjectId(input.host, path, p.repoUrl),
        name: p.name ?? basename(path),
        ...(p.repoUrl ? { repoUrl: p.repoUrl } : {}),
      } satisfies WorkspaceProject,
    };
  });
  if (input.host === localHost) {
    await Promise.all(scanned.map((s) => register(s.path).catch(() => {})));
  }
  const projects = scanned.map((s) => s.project);
  const projectRoots: Record<string, string> = {};
  for (const s of scanned) projectRoots[s.project.id] = s.path;

  const existing = matchWorkspace(await listWorkspaces(), input, projects);
  const id = existing?.id ?? (deps.newId ?? newWorkspaceId)();
  const dir = (await resolveWorkspaceDir(id)) ?? workspaceDir(id, root);
  // Locked, and the existing record is read INSIDE the lock: a rescan that read
  // `taskCounter` outside it would write a stale value back over a task create
  // that bumped it meanwhile, and the next task would be minted with an id
  // already in use. `updatedAt` is stamped here, so the shared writer does not.
  return withFileLock(
    workspaceFile(dir),
    async () => {
      const now = new Date().toISOString();
      const current = existing ? ((await readWorkspace(id)) ?? existing) : undefined;
      const host: WorkspaceHost = { root, projectRoots, seenAt: now };
      const hosts = { ...(current?.hosts ?? {}), [input.host]: host };
      // A project this scan did not find is dropped, unless another machine
      // still maps it: that scan speaks only for its own host.
      const kept = (current?.projects ?? []).filter(
        (p) =>
          !projects.some((n) => n.id === p.id) &&
          Object.entries(hosts).some(([h, m]) => h !== input.host && p.id in m.projectRoots),
      );
      const rec: WorkspaceRecord = {
        version: 2,
        id,
        name: input.name ?? current?.name ?? basename(root),
        projects: [...projects, ...kept],
        hosts,
        taskCounter: current?.taskCounter ?? 0,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await writeWorkspace(rec);
      return rec;
    },
    WORKSPACE_LOCK,
  );
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceRecord | null> {
  return updateWorkspace(id, (rec) => ({ ...rec, name }));
}

/**
 * Drop a workspace and its tasks. The FOLDER, its projects and their boxes are
 * untouched — this unregisters, it does not delete work.
 */
export async function removeWorkspace(id: string): Promise<boolean> {
  const dir = await resolveWorkspaceDir(id);
  if (!dir) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Every project id a client on `host` may hold for this workspace: the record's
 * own repo-keyed ids, plus `hashProjectPath(folder)` of each folder that host
 * has — a box record and the project registry key by FOLDER, so a
 * locally-checked-out project must answer to both.
 */
export function workspaceProjectIds(
  rec: Pick<WorkspaceRecord, 'projects' | 'hosts'>,
  host: string = osHostname(),
): string[] {
  const ids = new Set(rec.projects.map((p) => p.id));
  for (const path of Object.values(rec.hosts[host]?.projectRoots ?? {})) {
    ids.add(hashProjectPath(path));
  }
  return [...ids];
}

/**
 * The record as the API serves it, from the reading hub's point of view: its own
 * folder (when it has one) and the project ids its clients hold.
 */
export function toWorkspaceView(rec: WorkspaceRecord, host: string = osHostname()): Workspace {
  const local = rec.hosts[host];
  return {
    id: rec.id,
    name: rec.name,
    projects: rec.projects,
    hosts: rec.hosts,
    ...(local ? { root: local.root } : {}),
    projectIds: workspaceProjectIds(rec, host),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * The workspace a path on `host` belongs to: the one whose root there is the
 * longest PATH-SEGMENT prefix of it. Segment-aware so `/a/foobar` never matches
 * the workspace at `/a/foo`. Pure, so the CLI can run it over a fetched listing.
 */
export function findWorkspaceContaining<T extends { hosts: Record<string, { root: string }> }>(
  records: readonly T[],
  absPath: string,
  host: string,
): T | null {
  const target = stripTrailingSlash(absPath);
  let best: T | null = null;
  let bestRoot = '';
  for (const rec of records) {
    const root = rec.hosts[host]?.root;
    if (!root) continue;
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (!best || root.length > bestRoot.length) {
      best = rec;
      bestRoot = root;
    }
  }
  return best;
}

/** What a box says about where its work lives, for the workspace join. */
export interface BoxWorkspaceKey {
  /** The box repo's `origin`. The only key that works from a machine with no checkout. */
  originUrl?: string;
  /** The machine `projectRoot` is on. */
  host?: string;
  /** The box's project folder on `host`. */
  projectRoot?: string;
}

/**
 * The workspace a box belongs to. The repo is tried first: a cloud box's
 * `projectRoot` is a literal `/workspace` or a control box's throwaway clone,
 * neither of which is under anyone's workspace root, while its origin is the
 * same string everywhere. The folder match is the fallback for a project with
 * no remote (and for a host checkout registered before this hub knew its repo).
 *
 * A key with no `host` names a path on `localHost`: a bare absolute path only
 * ever means something on the machine reading it.
 */
export function workspaceForBox<
  T extends {
    projects: readonly { repoUrl?: string }[];
    hosts: Record<string, { root: string }>;
  },
>(records: readonly T[], key: BoxWorkspaceKey, localHost: string = osHostname()): T | null {
  const repo = normalizeRepoUrl(key.originUrl);
  if (repo) {
    const hit = records.find((r) => r.projects.some((p) => normalizeRepoUrl(p.repoUrl) === repo));
    if (hit) return hit;
  }
  if (key.projectRoot) {
    return findWorkspaceContaining(records, key.projectRoot, key.host ?? localHost);
  }
  return null;
}
