import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  getMachineLabel,
  hashProjectPath,
  listProjectsConfigured,
  machineKeyFor,
  machineKeyIn,
  registerProject,
  sanitizeMnemonic,
  thisMachine,
  toMachineRef,
  tryGetMachineId,
  withFileLock,
  type MachineRef,
  type ProjectEntry,
} from '@agentbox/config';
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

/**
 * The lock an add takes over the whole registry. Not a workspace file: the point
 * is to serialize the MATCH, which reads every record and may mint a new id.
 * `listWorkspaces` ignores it — it only reads id-shaped entries.
 */
const ADD_LOCK = join(WORKSPACES_DIR, '_add');

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
 * The id of a repo, wherever it is checked out. ONE definition, because two
 * writers must agree on it: a workspace record names its projects by it, and a
 * box registration with no host folder keys its project card by it. Two spellings
 * of the same hash meant a registered box's project id was never in its own
 * workspace's `projectIds`, so every join through that id missed.
 */
export function repoProjectKey(originUrl: string): string | undefined {
  const key = repoMatchKey(originUrl);
  return key === undefined ? undefined : hashProjectPath(key);
}

/**
 * What workspace project ids and workspace joins key a repo by: the
 * pre-`repoKey` normaliser, kept BYTE FOR BYTE. Workspace records, the tasks
 * filed under their project ids and box registrations already hold hashes of
 * this exact string, and `repoKey` spells some remotes differently (an scp
 * absolute path `host:/srv/x`, a percent-encoded path, `.GIT`, a local path),
 * so routing ids through `repoKey` would re-key those projects on their next
 * scan. Machine-independent identity for everything else (checkouts, custody)
 * is `repoKey`; moving workspace ids onto it is backlog B1.
 */
export function repoMatchKey(raw: string | undefined | null): string | undefined {
  const url = (raw ?? '').trim();
  if (!url) return undefined;
  const strip = (s: string): string => {
    let out = s;
    while (out.endsWith('/')) out = out.slice(0, -1);
    if (out.endsWith('.git')) out = out.slice(0, -'.git'.length);
    return out.toLowerCase();
  };
  if (url.startsWith('/')) return strip(url) || undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    const rest = scheme[2]!;
    const authEnd = rest.indexOf('@');
    const afterAuth = authEnd === -1 ? rest : rest.slice(authEnd + 1);
    const slash = afterAuth.indexOf('/');
    if (slash === -1) return undefined;
    const host = afterAuth.slice(0, slash).replace(/:\d+$/, '');
    const path = afterAuth.slice(slash + 1);
    if (!path) return undefined;
    return strip(host ? `${host}/${path}` : `/${path}`) || undefined;
  }
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(url);
  if (scp) return strip(`${scp[1]!}/${scp[2]!}`) || undefined;
  return strip(url) || undefined;
}

/**
 * The id of one project. A repo is the same project on every machine, so its id
 * is its normalised remote; a project with no remote exists only where its
 * folder is, so its id carries the host.
 */
export function workspaceProjectId(
  host: MachineRef | string,
  path: string,
  repoUrl?: string,
): string {
  return (
    (repoUrl === undefined ? undefined : repoProjectKey(repoUrl)) ??
    hashProjectPath(`${machineKeyFor(host)}:${stripTrailingSlash(path)}`)
  );
}

/**
 * A machine as the workspace layer names it: a `MachineRef`, or a bare hostname
 * from a caller (or a record) that predates machine ids.
 */
export type HostArg = MachineRef | string;

/**
 * Machine `host`'s entry in a `hosts` map: under its id, else under its hostname
 * for an entry written before ids existed (adopted, and re-stamped by the next
 * write — see {@link restampHosts}).
 */
export function hostEntryOf<H>(hosts: Readonly<Record<string, H>>, host: HostArg): H | undefined {
  const key = machineKeyIn(hosts, host);
  return key === undefined ? undefined : hosts[key];
}

/**
 * `hosts` with machine `me`'s legacy hostname-keyed entry moved under its id and
 * labelled (or its id entry relabelled after a hostname change), or `null` when
 * there is nothing to change. An entry keyed by some other machine's id is never
 * touched, and when `me` already has an id entry a legacy one beside it is left
 * where it is rather than dropped: it may be another machine's that shares the name.
 */
export function restampHosts(
  hosts: Readonly<Record<string, WorkspaceHost>>,
  me: MachineRef,
): Record<string, WorkspaceHost> | null {
  if (!me.id) return null;
  const legacy = hosts[me.label];
  const current = hosts[me.id];
  if (current) {
    if (current.label === me.label) return null;
    return { ...hosts, [me.id]: { ...current, label: me.label } };
  }
  if (!legacy || legacy.label !== undefined) return null;
  const next = { ...hosts };
  delete next[me.label];
  next[me.id] = { ...legacy, label: me.label };
  return next;
}

/** This machine's folder for a workspace, when it has one. */
export function workspaceRootOn(
  rec: { hosts: Record<string, { root: string }> },
  host: HostArg,
): string | undefined {
  return hostEntryOf(rec.hosts, host)?.root;
}

/** This machine's project folders for a workspace, in record order. */
export function workspaceProjectRootsOn(
  rec: Pick<WorkspaceRecord, 'projects' | 'hosts'>,
  host: HostArg,
): string[] {
  const map = hostEntryOf(rec.hosts, host)?.projectRoots ?? {};
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
 * workspace registered it.
 *
 * A project the registry no longer knows KEEPS its id and loses its folder and
 * repo: the folder is unrecoverable from a path hash, but dropping the project
 * would shrink the record — and the upgrade is persisted, so the loss would be
 * permanent. The next `workspace add` re-discovers the folder and replaces it.
 */
export function upgradeWorkspaceRecord(
  raw: WorkspaceRecordV1,
  host: HostArg,
  projects: readonly Pick<ProjectEntry, 'hash' | 'originalPath' | 'originUrl'>[],
): WorkspaceRecord {
  const known = new Map(projects.map((p) => [p.hash, p]));
  const out: WorkspaceProject[] = [];
  const projectRoots: Record<string, string> = {};
  for (const oldId of raw.projectIds) {
    const entry = known.get(oldId);
    if (!entry) {
      // All that survives is the id; the hash is the only name it has left.
      if (!out.some((p) => p.id === oldId)) out.push({ id: oldId, name: oldId.slice(0, 8) });
      continue;
    }
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
    hosts: {
      [machineKeyFor(host)]: {
        root: raw.root,
        projectRoots,
        seenAt: raw.updatedAt,
        ...(toMachineRef(host).id ? { label: toMachineRef(host).label } : {}),
      },
    },
    taskCounter: raw.taskCounter,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Parse one stored record, upgrading a version-less one. `registry` is resolved
 * once per read of many records — the upgrade is the only reader of it, and the
 * common case has nothing to upgrade.
 *
 * An upgraded record is written back before it is returned: the project registry
 * is the only source of the folders, and re-deriving them on every read (five
 * times per dashboard poll) both costs a registry read and lets the record shrink
 * the day the registry forgets a project.
 */
async function parseRecord(
  raw: string,
  host: MachineRef,
  registry: () => Promise<ProjectEntry[]>,
  migrate: boolean,
): Promise<WorkspaceRecord | null> {
  const parsed = JSON.parse(raw) as unknown;
  if (isV1(parsed)) {
    const upgraded = upgradeWorkspaceRecord(parsed, host, await registry());
    // Only an UNLOCKED read migrates: the file lock is not reentrant, so a read
    // from inside `updateWorkspace`/`addWorkspace` would wait out its own lock.
    // Those callers write the upgraded record themselves anyway.
    if (migrate) await persistUpgrade(upgraded);
    return upgraded;
  }
  const rec = parsed as WorkspaceRecord;
  if (rec.version !== 2 || typeof rec.id !== 'string') return null;
  // This machine's own folder mapping, written under its hostname before machine
  // ids existed: adopt it under the id, so a later hostname flip cannot orphan it.
  const hosts = restampHosts(rec.hosts, host);
  if (!hosts) return rec;
  // A legacy entry is only this machine's if its folder is on this disk: a PC
  // that happens to share the hub's hostname must not lose its mapping to it.
  const legacy = host.id && !rec.hosts[host.id] ? rec.hosts[host.label] : undefined;
  if (legacy && !(await isDirectory(legacy.root))) return rec;
  const restamped = { ...rec, hosts };
  if (migrate) await persistRestamp(rec.id, host);
  return restamped;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

/** Write a re-stamped host mapping back, under the lock, re-reading first. Best-effort. */
async function persistRestamp(id: string, me: MachineRef): Promise<void> {
  try {
    const dir = await resolveWorkspaceDir(id);
    if (!dir) return;
    await withFileLock(
      workspaceFile(dir),
      async () => {
        const raw = await readFile(workspaceFile(dir), 'utf8').catch(() => null);
        if (raw === null) return;
        const cur = JSON.parse(raw) as WorkspaceRecord;
        if (cur.version !== 2) return;
        const hosts = restampHosts(cur.hosts, me);
        if (hosts) await writeWorkspace({ ...cur, hosts });
      },
      WORKSPACE_LOCK,
    );
  } catch {
    // the in-memory re-stamp still serves this read
  }
}

/**
 * Write an upgraded record back, once. Locked and re-checked: a concurrent
 * reader upgrading the same file must not overwrite a v2 record someone has
 * meanwhile written (a `taskCounter` bump, a new host mapping). Best-effort — a
 * read never fails over its own migration.
 */
async function persistUpgrade(rec: WorkspaceRecord): Promise<void> {
  try {
    const dir = await resolveWorkspaceDir(rec.id);
    if (!dir) return;
    await withFileLock(
      workspaceFile(dir),
      async () => {
        const raw = await readFile(workspaceFile(dir), 'utf8').catch(() => null);
        if (raw === null || !isV1(JSON.parse(raw) as unknown)) return;
        await writeWorkspace(rec);
      },
      WORKSPACE_LOCK,
    );
  } catch {
    // migration is opportunistic: the in-memory upgrade still serves this read
  }
}

/** `listProjectsConfigured`, resolved at most once per read. */
function registryOnce(): () => Promise<ProjectEntry[]> {
  let pending: Promise<ProjectEntry[]> | undefined;
  return () => (pending ??= listProjectsConfigured().catch(() => []));
}

export async function readWorkspace(id: string): Promise<WorkspaceRecord | null> {
  return readWorkspaceRecord(id, true);
}

/** `readWorkspace`, with the migration write-back only when it is safe to take the lock. */
async function readWorkspaceRecord(id: string, migrate: boolean): Promise<WorkspaceRecord | null> {
  const dir = await resolveWorkspaceDir(id);
  if (!dir) return null;
  try {
    const raw = await readFile(workspaceFile(dir), 'utf8');
    return await parseRecord(raw, thisMachine(), registryOnce(), migrate);
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
  const host = thisMachine();
  const registry = registryOnce();
  const out: WorkspaceRecord[] = [];
  for (const name of entries) {
    if (!/^[0-9a-f]{16}(?:-.+)?$/.test(name)) continue;
    try {
      const raw = await readFile(workspaceFile(join(WORKSPACES_DIR, name)), 'utf8');
      const rec = await parseRecord(raw, host, registry, true);
      if (rec) out.push(rec);
    } catch {
      // skip malformed / partially-created
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function writeWorkspace(rec: WorkspaceRecord): Promise<void> {
  const mnemonic = workspaceRootOn(rec, thisMachine()) ?? Object.values(rec.hosts)[0]?.root;
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
      const current = await readWorkspaceRecord(id, false);
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
  /** The hub's own machine id (seam; defaults to `getMachineId()`). */
  machineId?: () => string;
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
  /** Hostname of the machine that scanned these folders: its label. */
  host: string;
  /**
   * `getMachineId()` of that machine — its identity, and the key its folders are
   * stored under. Absent from a client that predates machine ids: the hostname
   * is then the key, as before.
   */
  machineId?: string;
  /** Absolute folder on `host`. */
  root: string;
  name?: string;
  projects: WorkspaceProjectInput[];
  /** Update this record; without it the match is by (host, root), then by repo. */
  id?: string;
}

/**
 * The workspace an add refers to: the id it named, else the record already
 * mapping this (host, root), else one that shares a repo AND has no folder on
 * this host yet.
 *
 * That last clause is what keeps the repo match a MERGE rather than a hijack: a
 * record already mapping this host to some other folder is a different working
 * copy of the same repos, and adopting it would silently move the workspace the
 * user already has to the folder they just registered.
 */
function matchWorkspace(
  records: WorkspaceRecord[],
  input: { id?: string; machine: MachineRef; root: string },
  projects: readonly WorkspaceProject[],
): WorkspaceRecord | undefined {
  if (input.id) return records.find((r) => r.id === input.id);
  const byRoot = records.find((r) => hostEntryOf(r.hosts, input.machine)?.root === input.root);
  if (byRoot) return byRoot;
  // A client with no id whose machine was adopted under an id still names the
  // same record (by label and folder): it merges into it, under its hostname,
  // rather than minting a rival workspace for the folder.
  if (!input.machine.id) {
    const adopted = records.find((r) =>
      Object.values(r.hosts).some((h) => h.label === input.machine.label && h.root === input.root),
    );
    if (adopted) return adopted;
  }
  const repos = new Set(
    projects.map((p) => repoMatchKey(p.repoUrl)).filter((r): r is string => Boolean(r)),
  );
  if (repos.size === 0) return undefined;
  return records.find(
    (r) =>
      hostEntryOf(r.hosts, input.machine) === undefined &&
      r.projects.some((p) => {
        const repo = repoMatchKey(p.repoUrl);
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
  const localId = (deps.machineId ?? tryGetMachineId)();
  const local: MachineRef = {
    ...(localId ? { id: localId } : {}),
    label: (deps.hostname ?? getMachineLabel)(),
  };
  const root = stripTrailingSlash(input.root);
  // A scan with no id is from a client that predates machine ids, and its
  // hostname vouches for nothing: on a hub other PCs reach, a PC may share the
  // hub's name. It is this machine only when its folder is on this disk;
  // otherwise it stays keyed by hostname, never under this hub's id.
  const machine: MachineRef = input.machineId
    ? { id: input.machineId, label: input.host }
    : input.host === local.label && (await isDirectory(root))
      ? local
      : { label: input.host };
  const isLocal = machine.id !== undefined ? machine.id === local.id : machine === local;
  const scanned = input.projects.map((p) => {
    const path = stripTrailingSlash(p.path);
    return {
      path,
      project: {
        id: workspaceProjectId(machine, path, p.repoUrl),
        name: p.name ?? basename(path),
        ...(p.repoUrl ? { repoUrl: p.repoUrl } : {}),
      } satisfies WorkspaceProject,
    };
  });
  if (isLocal) {
    await Promise.all(scanned.map((s) => register(s.path).catch(() => {})));
  }
  const projects = scanned.map((s) => s.project);
  const projectRoots: Record<string, string> = {};
  for (const s of scanned) projectRoots[s.project.id] = s.path;

  // Matching and minting an id are ONE step, under a registry-wide lock: two
  // concurrent adds for the same new (host, root) — `registerHostManager` firing
  // from two terminals, or once per box in a multi-box create — would otherwise
  // both miss the match and mint two workspaces for one folder.
  return withFileLock(
    ADD_LOCK,
    async () => addLocked(input, machine, deps, { root, projects, projectRoots }),
    WORKSPACE_LOCK,
  );
}

/** The match-and-write half of `addWorkspace`, already under {@link ADD_LOCK}. */
async function addLocked(
  input: AddWorkspaceInput,
  machine: MachineRef,
  deps: AddWorkspaceDeps,
  scan: { root: string; projects: WorkspaceProject[]; projectRoots: Record<string, string> },
): Promise<WorkspaceRecord> {
  const { root } = scan;
  const existing = matchWorkspace(
    await listWorkspaces(),
    { ...(input.id ? { id: input.id } : {}), machine, root },
    scan.projects,
  );
  // An id that names nothing is a stale reference, not a request for a new
  // workspace: minting one here would answer `POST /workspaces {id}` with a
  // record under a DIFFERENT id, and leave the caller's tasks behind.
  if (input.id && !existing) throw new Error(`unknown workspace ${input.id}`);
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
      const current = existing ? ((await readWorkspaceRecord(id, false)) ?? existing) : undefined;
      let prevKey = current ? machineKeyIn(current.hosts, machine) : undefined;
      // A hostname-keyed entry for a DIFFERENT folder is not proof it is this
      // machine's: it may be a namesake's, so it is left where it is.
      if (machine.id && prevKey === machine.label && current?.hosts[prevKey]?.root !== root) {
        prevKey = undefined;
      }
      const { projects, projectRoots } = keepLocalProjectIds(
        scan,
        prevKey === undefined ? undefined : current?.hosts[prevKey],
      );
      const key = machineKeyFor(machine);
      const host: WorkspaceHost = {
        root,
        projectRoots,
        seenAt: now,
        ...(machine.id ? { label: machine.label } : {}),
      };
      const hosts = { ...(current?.hosts ?? {}) };
      // The machine's hostname-keyed entry, from before it sent an id: replaced
      // by the id-keyed one, never kept beside it.
      if (prevKey !== undefined && prevKey !== key) delete hosts[prevKey];
      hosts[key] = host;
      // A project this scan did not find is dropped, unless another machine
      // still maps it: that scan speaks only for its own host.
      const kept = (current?.projects ?? []).filter(
        (p) =>
          !projects.some((n) => n.id === p.id) &&
          Object.entries(hosts).some(([h, m]) => h !== key && p.id in m.projectRoots),
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

/**
 * A no-remote project's id hashes the machine that holds it, and that name used
 * to be the hostname. Re-deriving it from the machine id would hand the same
 * folder a new id and orphan every task filed against the old one, so a folder
 * this machine already mapped keeps the id it was mapped under.
 */
function keepLocalProjectIds(
  scan: { projects: WorkspaceProject[]; projectRoots: Record<string, string> },
  previous: WorkspaceHost | undefined,
): { projects: WorkspaceProject[]; projectRoots: Record<string, string> } {
  if (!previous) return scan;
  const byPath = new Map(Object.entries(previous.projectRoots).map(([pid, path]) => [path, pid]));
  const projects: WorkspaceProject[] = [];
  const projectRoots: Record<string, string> = {};
  for (const p of scan.projects) {
    const path = scan.projectRoots[p.id];
    const old = path === undefined ? undefined : byPath.get(path);
    const id = !p.repoUrl && old !== undefined ? old : p.id;
    projects.push(id === p.id ? p : { ...p, id });
    if (path !== undefined) projectRoots[id] = path;
  }
  return { projects, projectRoots };
}

/**
 * Re-key machine `me`'s legacy hostname entry in workspace `id` under its id.
 * For a machine other than the reading hub's (whose own entries a read already
 * adopts): a PC's detect on a control box. A no-op when there is nothing to move.
 */
export async function restampWorkspaceHost(id: string, me: MachineRef): Promise<void> {
  if (!me.id) return;
  const rec = await readWorkspace(id);
  if (!rec || !restampHosts(rec.hosts, me)) return;
  await updateWorkspace(id, (cur) => ({ ...cur, hosts: restampHosts(cur.hosts, me) ?? cur.hosts }));
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
  host: HostArg = thisMachine(),
): string[] {
  const ids = new Set(rec.projects.map((p) => p.id));
  for (const path of Object.values(hostEntryOf(rec.hosts, host)?.projectRoots ?? {})) {
    ids.add(hashProjectPath(path));
  }
  return [...ids];
}

/**
 * The record as the API serves it, from the reading hub's point of view: its own
 * folder (when it has one) and the project ids its clients hold.
 */
export function toWorkspaceView(rec: WorkspaceRecord, host: HostArg = thisMachine()): Workspace {
  const local = hostEntryOf(rec.hosts, host);
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
  host: HostArg,
): T | null {
  const target = stripTrailingSlash(absPath);
  let best: T | null = null;
  let bestRoot = '';
  for (const rec of records) {
    const root = hostEntryOf(rec.hosts, host)?.root;
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
  /** The machine `projectRoot` is on (a bare string is its hostname). */
  host?: HostArg;
  /** The box's project folder on `host`. */
  projectRoot?: string;
}

/**
 * The workspace a box belongs to, most specific key first.
 *
 * The FOLDER wins when the box has one under a workspace root: it names the
 * actual working copy, and the longest root wins, so a box in a repo registered
 * both on its own and inside a parent workspace lands in the narrower one. A
 * repo is a weaker identity — two workspaces can legitimately list it — so it
 * would otherwise hand the box to whichever record happens to sort first.
 *
 * The repo is the fallback that makes the join work from a machine with no
 * checkout: a cloud box's `projectRoot` is a literal `/workspace` and a control
 * box's is a throwaway clone, neither under anyone's root, while the origin is
 * the same string everywhere.
 *
 * A key with no `host` names a path on `localHost`: a bare absolute path only
 * ever means something on the machine reading it.
 */
export function workspaceForBox<
  T extends {
    projects: readonly { repoUrl?: string }[];
    hosts: Record<string, { root: string }>;
  },
>(records: readonly T[], key: BoxWorkspaceKey, localHost: HostArg = thisMachine()): T | null {
  if (key.projectRoot) {
    const here = findWorkspaceContaining(records, key.projectRoot, key.host ?? localHost);
    if (here) return here;
  }
  const repo = repoMatchKey(key.originUrl);
  if (repo) {
    return records.find((r) => r.projects.some((p) => repoMatchKey(p.repoUrl) === repo)) ?? null;
  }
  return null;
}
