import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findProjectRoot,
  hashProjectPath,
  isProviderKind,
  listProjectsConfigured,
  PROVIDER_NAMES,
  providerMeta,
  registerProject,
  unregisterProject,
  type ProviderKind,
} from '@agentbox/config';
import { normalizeLastAgent, type BoxRecord, type ExecResult, type Provider } from '@agentbox/core';
import type { BoxStatus as CtlBoxStatus, StatusReply } from '@agentbox/ctl';
import {
  enqueueQueueJob,
  hashRpcParams,
  isValidBoxStatus,
  loadQueue,
  readJob,
  type PendingApproval,
  type QueueAgentKind,
  type QueueJob,
  type RelayServerHandle,
} from '@agentbox/relay';
import type { BoxGitDeps, ProviderModule } from '@agentbox/sandbox-core';
import {
  BOX_WORKSPACE,
  boxGitCheckout,
  boxGitNewBranch,
  boxGitPull,
  boxGitPush,
  boxGitPushHost,
  boxRestartService,
  boxRestartServices,
  boxServicesStatusRaw,
  readPreparedStateRaw,
  readState,
} from '@agentbox/sandbox-core';
import { listBoxes, mintHostInitiatedToken, type ListedBox } from '@agentbox/sandbox-docker';
import type {
  ActionResult,
  BoxOpResult,
  BrowseDirResult,
  CreateBoxInput,
  CreateBoxResult,
  DirEntry,
  GitInfo,
  HubBackend,
  ServicesResult,
} from './boxes/backend-types';
import type { Approval, Box, BoxStatus, GithubState, HubState, Project, ProviderOption, User } from './boxes/types';

/*
 * Node-only host backend. This module imports the sandbox/relay toolchain and is
 * loaded ONLY by the custom server (server.ts, run via tsx). Next never imports
 * it — it reaches these methods through globalThis.__AGENTBOX_HUB_BACKEND — so
 * the docker/ssh/cloud-SDK graph never enters Next's bundle.
 */

// ── provider resolution (mirrors apps/cli/src/provider/loaders.ts) ──
const IMPORTERS: Record<ProviderKind, () => Promise<{ providerModule: ProviderModule }>> = {
  docker: () => import('@agentbox/sandbox-docker'),
  daytona: () => import('@agentbox/sandbox-daytona'),
  hetzner: () => import('@agentbox/sandbox-hetzner'),
  vercel: () => import('@agentbox/sandbox-vercel'),
  e2b: () => import('@agentbox/sandbox-e2b'),
};

async function providerForBox(box: BoxRecord): Promise<Provider> {
  const name = box.provider ?? 'docker';
  if (!isProviderKind(name)) {
    throw new Error(`box ${box.id}: unsupported provider "${name}" (built-in providers only)`);
  }
  const mod = (await IMPORTERS[name]()).providerModule;
  if (mod.ensureCredentials) await mod.ensureCredentials();
  return mod.provider;
}

// ── ListedBox → UI view model ──
// Project id = the config registry's canonical key (SHA-1/16 of the path), so
// registry-derived and box-derived projects share one id and `create` can
// resolve a projectId back to its registered path.
function projectRootOf(b: ListedBox): string {
  return b.projectRoot ?? b.workspacePath ?? b.id;
}

function mapStatus(b: ListedBox): BoxStatus {
  const errored = b.claudeActivity === 'error' || b.codexActivity === 'error';
  switch (b.state) {
    case 'running':
      return errored ? 'error' : 'running';
    case 'paused':
      return 'paused';
    default:
      return 'stopped'; // stopped | missing | destroyed
  }
}

function hostLabel(b: ListedBox): string {
  const provider = b.provider ?? 'docker';
  if (provider === 'docker') return 'local · docker';
  return b.cloud?.backend ? `${provider} · ${b.cloud.backend}` : provider;
}

function mapBox(b: ListedBox): Box {
  const root = projectRootOf(b);
  const createdAt = Date.parse(b.createdAt) || Date.now();
  const status = mapStatus(b);
  return {
    id: b.id,
    projectId: hashProjectPath(root),
    repo: path.basename(root),
    branch: b.gitWorktrees?.[0]?.branch ?? b.cloud?.workspaceBranch ?? '',
    task: b.claudeSessionTitle ?? b.codexSessionTitle ?? b.opencodeSessionTitle ?? b.name,
    // Normalize the frozen wire spelling ('claude-code') to the UI label ('claude').
    agent: normalizeLastAgent(b.lastAgent) ?? 'claude',
    status,
    createdAt,
    lastActivity: createdAt,
    host: hostLabel(b),
    commits: null,
    filesTouched: null,
    error: status === 'error' ? (b.claudeSessionTitle ?? 'Agent reported an error') : null,
  };
}

/**
 * The project list unions the on-disk registry (`~/.agentbox/projects`, which
 * includes folders that have *zero* boxes) with the roots of live boxes. It also
 * self-heals: any box root not yet registered is registered here, so projects
 * created before the registry existed (or via a create path that skips
 * registration) still appear and become resolvable by `create`.
 */
async function listProjects(boxes: ListedBox[]): Promise<Project[]> {
  // Per-root metadata from live boxes: provider + earliest createdAt.
  const boxByRoot = new Map<string, { root: string; provider: string; createdAt: number }>();
  for (const b of boxes) {
    const root = projectRootOf(b);
    const createdAt = Date.parse(b.createdAt) || Date.now();
    const existing = boxByRoot.get(root);
    if (!existing) boxByRoot.set(root, { root, provider: b.provider ?? 'docker', createdAt });
    else if (createdAt < existing.createdAt) existing.createdAt = createdAt;
  }
  // Self-heal: register any box root missing from the registry (best-effort).
  await Promise.all([...boxByRoot.keys()].map((r) => registerProject(r).catch(() => {})));

  const byId = new Map<string, Project>();
  // Registry entries (incl. zero-box projects).
  for (const e of await listProjectsConfigured()) {
    const box = boxByRoot.get(e.originalPath);
    byId.set(e.hash, {
      id: e.hash,
      name: path.basename(e.originalPath),
      repo: path.basename(e.originalPath),
      defaultBranch: 'main',
      provider: box?.provider ?? 'docker',
      createdAt: box?.createdAt ?? (e.createdAt ? Date.parse(e.createdAt) || Date.now() : Date.now()),
    });
  }
  // Belt-and-suspenders: any box root that failed to register still shows up.
  for (const p of boxByRoot.values()) {
    const id = hashProjectPath(p.root);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: path.basename(p.root),
        repo: path.basename(p.root),
        defaultBranch: 'main',
        provider: p.provider,
        createdAt: p.createdAt,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Resolve a client-supplied projectId to its absolute host path. Mirrors what
 * `listProjects` shows: the on-disk registry first, then live box roots (a
 * project can surface from a box root even if its registry registration failed).
 * Registering the healed root keeps it resolvable next time. Returns null only
 * when no project the UI could display matches — so `create` never rejects a
 * project the user can actually see on the dashboard.
 */
async function resolveProjectPath(projectId: string): Promise<string | null> {
  const entry = (await listProjectsConfigured()).find((e) => e.hash === projectId);
  if (entry) return entry.originalPath;
  for (const b of await listBoxes()) {
    const root = projectRootOf(b);
    if (hashProjectPath(root) === projectId) {
      await registerProject(root).catch(() => {});
      return root;
    }
  }
  return null;
}

// Map QueueAgentKind ('claude-code') to the UI agent label ('claude').
const AGENT_LABEL: Record<QueueAgentKind, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * Render an in-flight (or just-failed) create job as a synthetic Box, so a box
 * being built appears in the dashboard as `creating` and flips to `running` once
 * the real box lands in `listBoxes()`. `id` is prefixed `job:` until the worker
 * writes back the real `boxId`, so it never collides with a live box.
 */
function mapJobToBox(job: QueueJob, status: BoxStatus): Box {
  const root = job.createOpts.workspace;
  const createdAt = Date.parse(job.createdAt) || Date.now();
  return {
    id: job.boxId ?? `job:${job.id}`,
    projectId: hashProjectPath(root),
    repo: path.basename(root),
    branch: '',
    task: job.prompt || job.boxName || 'new box',
    // A no-agent box ("just create") has no agent — show the shell glyph.
    agent: job.noAgent ? 'shell' : (AGENT_LABEL[job.agent] ?? 'claude'),
    status,
    createdAt,
    lastActivity: createdAt,
    host: job.providerName === 'docker' ? 'local · docker' : job.providerName,
    commits: null,
    filesTouched: null,
    error: status === 'error' ? (job.reason ?? 'create failed') : null,
  };
}

/**
 * Which providers a box can be created on right now. docker is always available
 * (its base self-heals); a cloud provider is usable only once its base is baked —
 * `~/.agentbox/<provider>-prepared.json` with a `base`. That marker read is sync +
 * offline (no cloud SDK), so it's cheap to compute on every getData(). A prepared
 * marker implies a prior `<provider> login`, so it's a sufficient readiness proxy.
 */
function isProviderConfigured(id: ProviderKind): boolean {
  if (id === 'docker') return true;
  const raw = readPreparedStateRaw(id);
  return !!(raw && typeof raw === 'object' && (raw as { base?: unknown }).base);
}

function listProviders(): ProviderOption[] {
  return PROVIDER_NAMES.map((id) => {
    // Keep "Docker (local)" but drop the "(cloud …)" qualifier from cloud labels
    // — the picker just wants the provider name.
    const label = id === 'docker' ? providerMeta(id).label : providerMeta(id).label.replace(/\s*\(.*\)$/, '');
    const configured = isProviderConfigured(id);
    return {
      id,
      label,
      configured,
      reason: configured
        ? undefined
        : `Not set up on this host — run \`agentbox ${id} login\` then \`agentbox prepare --provider ${id}\``,
    };
  });
}

function currentUser(): User {
  let login = 'user';
  try {
    login = os.userInfo().username || 'user';
  } catch {
    // os.userInfo can throw on some images; fall back.
  }
  return { login, name: login };
}

const LOCAL_GITHUB: GithubState = {
  available: false,
  installed: false,
  appName: 'GitHub App',
  account: '',
  installedAt: 0,
  repos: [],
};

function mapApproval(p: PendingApproval): Approval {
  return {
    id: p.id,
    boxId: p.boxId,
    message: p.ev.message,
    detail: p.ev.detail,
    command: p.ev.context?.command,
    cwd: p.ev.context?.cwd,
    argv: p.ev.context?.argv,
    defaultAnswer: p.ev.defaultAnswer ?? 'n',
    createdAt: Date.parse(p.createdAt) || Date.now(),
  };
}

// A folder "looks like a project" if it already carries a git repo or an
// agentbox.yaml — the same signals `findProjectRoot` walks up to.
async function looksLikeProject(dir: string): Promise<boolean> {
  const [git, yaml] = await Promise.all([
    stat(path.join(dir, '.git')).then(() => true).catch(() => false),
    stat(path.join(dir, 'agentbox.yaml')).then(() => true).catch(() => false),
  ]);
  return git || yaml;
}

// List the immediate subdirectories of `dir` (defaulting to the user's home) for
// the folder picker. Hidden dirs (dotfiles) are skipped to keep the list to real
// project candidates; symlinks are followed only when they resolve to a directory.
async function browseDirHost(dir?: string): Promise<BrowseDirResult> {
  try {
    const target = dir && dir.trim() ? dir.trim() : os.homedir();
    if (!path.isAbsolute(target)) return { ok: false, error: 'an absolute path is required' };
    const st = await stat(target).catch(() => null);
    if (!st || !st.isDirectory()) return { ok: false, error: `not a directory: ${target}` };

    const dirents = await readdir(target, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const full = path.join(target, d.name);
      if (d.isSymbolicLink()) {
        const ls = await stat(full).catch(() => null);
        if (!ls || !ls.isDirectory()) continue;
      }
      entries.push({ name: d.name, path: full, isProject: await looksLikeProject(full) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    return { ok: true, path: target, parent: parent === target ? null : parent, entries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runLifecycle(id: string, op: (box: BoxRecord, provider: Provider) => Promise<void>): Promise<ActionResult> {
  try {
    const { boxes } = await readState();
    const box = boxes.find((b) => b.id === id);
    if (!box) return { ok: false, error: `box ${id} not found` };
    const provider = await providerForBox(box);
    await op(box, provider);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Resolve a box id to its record + provider, or null when the box is gone. */
async function resolveBoxProvider(id: string): Promise<{ box: BoxRecord; provider: Provider } | null> {
  const { boxes } = await readState();
  const box = boxes.find((b) => b.id === id);
  if (!box) return null;
  return { box, provider: await providerForBox(box) };
}

/** Generous TTL matching the host CLI: a slow push over a flaky uplink can take ~60s. */
const GIT_TOKEN_TTL_MS = 120_000;

/**
 * BoxGitDeps for the shared helpers: mint a one-time host-initiated token bound
 * to the RPC's (method, params) hash so the relay skips its confirm prompt. The
 * mint endpoint is loopback-only and the hub server *is* the relay process, so
 * this reaches it in-process. Null (relay unreachable) falls back to the prompt
 * path; `agentbox/*` scratch pushes auto-allow regardless.
 */
function hubGitDeps(boxId: string): BoxGitDeps {
  return {
    hostInitiatedArgs: async (method, params) => {
      const token = await mintHostInitiatedToken(boxId, method, hashRpcParams(params), GIT_TOKEN_TTL_MS);
      return token ? ['--host-initiated-token', token] : [];
    },
  };
}

/** Run a box-git helper and map its exec result to a BoxOpResult. */
async function gitOp(id: string, fn: (box: BoxRecord, provider: Provider) => Promise<ExecResult>): Promise<BoxOpResult> {
  try {
    const rp = await resolveBoxProvider(id);
    if (!rp) return { ok: false, error: `box ${id} not found` };
    const r = await fn(rp.box, rp.provider);
    if (r.exitCode !== 0) {
      return { ok: false, error: (r.stderr || r.stdout || `command exited ${String(r.exitCode)}`).trim() };
    }
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

/** Pull the live `agentbox-ctl status --json` snapshot, or null when unreachable. */
async function liveServices(provider: Provider, box: BoxRecord): Promise<StatusReply | null> {
  const r = await boxServicesStatusRaw(provider, box).catch(() => null);
  if (!r || r.exitCode !== 0) return null;
  try {
    return JSON.parse(r.stdout) as StatusReply;
  } catch {
    return null;
  }
}

function mapLiveServices(live: StatusReply): ServicesResult {
  return {
    source: 'live',
    services: live.services.map((s) => ({
      name: s.name,
      state: s.state,
      pid: s.pid,
      restarts: s.restarts,
      lastExitCode: s.lastExitCode,
      blockedOn: s.blockedOn,
      command: s.command,
    })),
    tasks: live.tasks.map((t) => ({ name: t.name, state: t.state })),
    ports: live.ports.map((p) => ({ port: p.port, service: p.service })),
  };
}

// The persisted snapshot lacks pid/restarts/lastExitCode/command (the compact
// BoxStatusServiceEntry shape); fill with nulls/defaults.
function mapPersistedServices(s: CtlBoxStatus): ServicesResult {
  return {
    source: 'persisted',
    services: s.services.map((sv) => ({
      name: sv.name,
      state: sv.state,
      pid: null,
      restarts: 0,
      lastExitCode: null,
      blockedOn: [],
      command: '',
    })),
    tasks: s.tasks.map((t) => ({ name: t.name, state: t.state })),
    ports: s.ports.map((p) => ({ port: p.port, service: p.service })),
  };
}

/** Parse `git status --porcelain=v2 --branch` into a live git summary. */
function parseGitStatus(out: string): GitInfo {
  let branch: string | undefined;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith('#')) {
      dirty = true;
    }
  }
  // git reports '(detached)' for a detached HEAD — surface it as no branch.
  return { ok: true, branch: branch === '(detached)' ? undefined : branch, dirty, ahead, behind };
}

export function createHubBackend(handle: RelayServerHandle): HubBackend {
  return {
    // authMode is layered on by source.ts (an env-derived concern), so the host
    // backend produces everything else.
    async getData(): Promise<Omit<HubState, 'authMode'>> {
      const [listed, jobs] = await Promise.all([listBoxes(), loadQueue()]);
      // Surface in-flight create jobs as synthetic `creating` boxes (and just-
      // failed ones as `error`) until the real box lands in listBoxes() and
      // takes over — matched by the boxId the worker writes back to the manifest.
      const liveIds = new Set(listed.map((b) => b.id));
      const jobBoxes: Box[] = [];
      for (const j of jobs) {
        if (j.boxId && liveIds.has(j.boxId)) continue;
        if (j.status === 'queued' || j.status === 'running') jobBoxes.push(mapJobToBox(j, 'creating'));
        else if (j.status === 'failed') jobBoxes.push(mapJobToBox(j, 'error'));
      }
      return {
        user: currentUser(),
        github: LOCAL_GITHUB,
        projects: await listProjects(listed),
        boxes: [...jobBoxes, ...listed.map(mapBox)],
        // Block-mode approvals live in-process on the relay handle, not the Store.
        approvals: handle.prompts.all().map(mapApproval),
        providers: listProviders(),
      };
    },
    pause: (id) => runLifecycle(id, (box, provider) => provider.pause(box)),
    resume: (id) => runLifecycle(id, (box, provider) => provider.resume(box)),
    stop: (id) => runLifecycle(id, (box, provider) => provider.stop(box)),
    destroy: (id) => runLifecycle(id, (box, provider) => provider.destroy(box)),
    // Mirror POST /admin/prompts/answer's block branch, in-process: resolving
    // the entry fulfills the Promise the /rpc handler is awaiting (box unblocks),
    // and the broadcast clears any attached-terminal footer.
    answerApproval(id, answer): Promise<ActionResult> {
      const boxId = handle.prompts.boxFor(id);
      if (!boxId) return Promise.resolve({ ok: false, error: 'no pending approval' });
      if (!handle.prompts.resolve(id, answer)) {
        return Promise.resolve({ ok: false, error: 'no pending approval' });
      }
      handle.subscribers.broadcast(boxId, 'prompt-resolved', { id });
      return Promise.resolve({ ok: true });
    },
    async create(input: CreateBoxInput): Promise<CreateBoxResult> {
      try {
        // Resolve the project by id server-side — never trust a client path.
        // Accepts any project the dashboard shows (registry or live box root).
        const workspace = await resolveProjectPath(input.projectId);
        if (!workspace) return { ok: false, error: `unknown project ${input.projectId}` };
        // Provider gate (defense-in-depth: a client could bypass the disabled UI
        // option). Default docker; reject unknown kinds and unconfigured providers.
        const provider = input.provider ?? 'docker';
        if (!isProviderKind(provider)) return { ok: false, error: `unknown provider ${provider}` };
        if (!isProviderConfigured(provider)) {
          return { ok: false, error: `provider ${provider} is not set up on this host` };
        }
        const noAgent = input.agent === 'none';
        // For a no-agent box `agent` is inert (the worker ignores it when noAgent);
        // keep a valid placeholder so the closed QueueAgentKind union holds.
        const agent: QueueAgentKind =
          input.agent === 'claude' || input.agent === 'none' ? 'claude-code' : input.agent;
        const name = input.name?.trim() || undefined;
        // Enqueue a detached create job (the same pipeline as `agentbox <agent>
        // -i`): the worker runs createBox() — including the full sync layer —
        // then starts the agent in a detached tmux session (unless noAgent, which
        // stops after create, like `agentbox create`). It never attaches. The
        // worker names the box from `createOpts.name` (like the CLI's
        // pickCreateOpts), so the typed name must go there, not only on boxName.
        const { job } = await enqueueQueueJob({
          agent,
          boxName: name ?? '',
          providerName: provider,
          prompt: noAgent ? '' : (input.prompt ?? ''),
          agentArgs: [],
          ...(noAgent ? { noAgent: true } : {}),
          createOpts: { workspace, name },
        });
        handle.pokeQueue();
        return { ok: true, jobId: job.id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async addProject(absPath: string): Promise<ActionResult> {
      try {
        if (!absPath || !path.isAbsolute(absPath)) {
          return { ok: false, error: 'an absolute path is required' };
        }
        const st = await stat(absPath).catch(() => null);
        if (!st || !st.isDirectory()) return { ok: false, error: `not a directory: ${absPath}` };
        // Canonicalize to a project root (walks up to an agentbox.yaml if any),
        // matching how create resolves the workspace.
        const root = (await findProjectRoot(absPath)).root;
        await registerProject(root);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async removeProject(projectId: string): Promise<ActionResult> {
      try {
        // Empty-only: refuse if any live box OR any create job that still SURFACES
        // as a box in getData() belongs to this project — otherwise DELETE would
        // unregister a project the dashboard still lists (and the UI hides Delete
        // for). Mirror getData()'s exact surfacing predicate: a job shows as a box
        // unless a live box already superseded it and its status is queued/running
        // ('creating') or failed ('error'). done/cancelled never surface.
        const [boxes, jobs] = await Promise.all([listBoxes(), loadQueue()]);
        const hasBox = boxes.some((b) => hashProjectPath(projectRootOf(b)) === projectId);
        const liveIds = new Set(boxes.map((b) => b.id));
        const hasJob = jobs.some(
          (j) =>
            !(j.boxId && liveIds.has(j.boxId)) &&
            (j.status === 'queued' || j.status === 'running' || j.status === 'failed') &&
            hashProjectPath(j.createOpts.workspace) === projectId,
        );
        if (hasBox || hasJob) return { ok: false, error: 'project has boxes; delete them first' };
        // Idempotent: unregisterProject returns false when already gone — still ok,
        // the goal state is "not registered".
        await unregisterProject(projectId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    browseDir: (dir) => browseDirHost(dir),
    async getJob(id): Promise<{ status: string; logPath: string; boxId?: string } | null> {
      const job = await readJob(id);
      if (!job) return null;
      return { status: job.status, logPath: job.logPath, boxId: job.boxId };
    },

    // ── box git operations (delegate to the shared, provider-agnostic helpers) ──
    gitCheckout: (id, branch) => gitOp(id, (box, provider) => boxGitCheckout(provider, box, branch)),
    gitNewBranch: (id, input) =>
      gitOp(id, (box, provider) => boxGitNewBranch(provider, box, input.name, input.from)),
    gitPush: (id, input = {}) =>
      gitOp(id, (box, provider) => boxGitPush(provider, box, input, hubGitDeps(id))),
    gitPull: (id, input = {}) =>
      gitOp(id, (box, provider) => boxGitPull(provider, box, input, hubGitDeps(id))),
    gitPushHost: (id, input = {}) => gitOp(id, (box, provider) => boxGitPushHost(provider, box, input)),
    async getGit(id): Promise<GitInfo> {
      try {
        const rp = await resolveBoxProvider(id);
        if (!rp) return { ok: false, error: `box ${id} not found` };
        const r = await rp.provider.exec(rp.box, ['git', 'status', '--porcelain=v2', '--branch'], {
          cwd: BOX_WORKSPACE,
        });
        if (r.exitCode !== 0) return { ok: false, error: (r.stderr || `git status exited ${String(r.exitCode)}`).trim() };
        return parseGitStatus(r.stdout);
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },

    // ── box service control ──
    async getServices(id): Promise<ServicesResult> {
      const rp = await resolveBoxProvider(id).catch(() => null);
      if (!rp) return { source: 'unavailable', services: [], tasks: [], ports: [], error: `box ${id} not found` };
      const live = await liveServices(rp.provider, rp.box);
      if (live) return mapLiveServices(live);
      const snap = handle.statusStore.get(id);
      if (snap && isValidBoxStatus(snap)) return mapPersistedServices(snap as unknown as CtlBoxStatus);
      return { source: 'unavailable', services: [], tasks: [], ports: [] };
    },
    async restartService(id, name): Promise<BoxOpResult> {
      try {
        const rp = await resolveBoxProvider(id);
        if (!rp) return { ok: false, error: `box ${id} not found` };
        if (name) {
          const r = await boxRestartService(rp.provider, rp.box, name);
          return r.exitCode === 0
            ? { ok: true, stdout: r.stdout, stderr: r.stderr }
            : { ok: false, error: (r.stderr || `restart ${name} exited ${String(r.exitCode)}`).trim() };
        }
        // Restart all: read the live service list, then restart each in sequence.
        const live = await liveServices(rp.provider, rp.box);
        if (!live) return { ok: false, error: 'could not reach the box supervisor (is the box running?)' };
        const names = live.services.map((s) => s.name);
        if (names.length === 0) return { ok: true };
        const results = await boxRestartServices(rp.provider, rp.box, names);
        const failed = results.filter((r) => r.result.exitCode !== 0).map((r) => r.name);
        return failed.length > 0 ? { ok: false, error: `failed to restart: ${failed.join(', ')}` } : { ok: true };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  };
}
