import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  findProjectRoot,
  hashProjectPath,
  isProviderKind,
  listProjectsConfigured,
  loadEffectiveConfig,
  PROVIDER_NAMES,
  providerMeta,
  registerProject,
  resolveDefaultCheckpoint,
  setConfigValue,
  unregisterProject,
  unsetConfigValue,
  type ProviderKind,
} from '@agentbox/config';
import { normalizeLastAgent, type BoxRecord, type ExecResult, type Provider } from '@agentbox/core';
import type { BoxStatus as CtlBoxStatus, StatusReply } from '@agentbox/ctl';
import {
  deleteJob,
  enqueuePrepareJob,
  enqueueQueueJob,
  FsCustodyStore,
  hashRpcParams,
  isValidBoxStatus,
  loadQueue,
  readJob,
  registrationToBoxRecord,
  writeQueueLoginCode,
  type BoxRegistration,
  type CustodyStore,
  type PendingApproval,
  type QueueAgentKind,
  type QueueJob,
  type RelayServerHandle,
} from '@agentbox/relay';
import { hydratePreparedFromCustody } from './prepared-hydrate.js';
import type { BoxGitDeps, ProviderModule } from '@agentbox/sandbox-core';
import {
  BOX_WORKSPACE,
  autoWriteSshConfig,
  boxGitCheckout,
  boxGitNewBranch,
  boxGitPull,
  boxGitPush,
  boxGitPushHost,
  boxRestartService,
  boxRestartServices,
  boxServicesStatusRaw,
  boxSshDirForProvider,
  readPreparedStateRaw,
  readState,
  recordBox,
  secretsEnvPath,
  setBoxDisplayName,
  syncAgentboxSshConfig,
} from '@agentbox/sandbox-core';
import {
  baseFreshnessFromFingerprints,
  currentCloudBaseFingerprint,
  openWebAppOnVncScreen,
  type BaseStatus,
} from '@agentbox/sandbox-cloud';
import {
  ensureBoxBrowserShowingApp,
  generateRelayToken,
  listBoxes,
  mintHostInitiatedToken,
  type ListedBox,
} from '@agentbox/sandbox-docker';
import type {
  ActionResult,
  BoxOpResult,
  BranchList,
  BrowseDirResult,
  CreateBoxInput,
  CreateBoxResult,
  DirEntry,
  GitInfo,
  HubBackend,
  OpenInApp,
  OpenTargets,
  OpenTargetsReport,
  RemoteDockerHostView,
  ServicesResult,
} from './boxes/backend-types';
import { hubProfile } from './auth-config';
import type { Approval, Box, BoxStatus, GithubState, HubState, Project, ProviderOption, User } from './boxes/types';

/*
 * Node-only host backend. This module imports the sandbox/relay toolchain and is
 * loaded ONLY by the custom server (server.ts, run via tsx). Next never imports
 * it — it reaches these methods through globalThis.__AGENTBOX_HUB_BACKEND — so
 * the docker/ssh/cloud-SDK graph never enters Next's bundle.
 */

const execFileAsync = promisify(execFile);

// Cosmetic rename-label cap — mirrors the CLI's --set-name cap and parseRenameBox.
const DISPLAY_NAME_MAX = 60;

// ── provider resolution (mirrors apps/cli/src/provider/loaders.ts) ──
const IMPORTERS: Record<ProviderKind, () => Promise<{ providerModule: ProviderModule }>> = {
  docker: () => import('@agentbox/sandbox-docker'),
  daytona: () => import('@agentbox/sandbox-daytona'),
  hetzner: () => import('@agentbox/sandbox-hetzner'),
  vercel: () => import('@agentbox/sandbox-vercel'),
  e2b: () => import('@agentbox/sandbox-e2b'),
  digitalocean: () => import('@agentbox/sandbox-digitalocean'),
  'remote-docker': () => import('@agentbox/sandbox-remote-docker'),
};

// Per-provider serialization of prepare-enqueue: `prepareProvider` reads the
// queue then enqueues, which isn't atomic across two concurrent POSTs (both could
// miss an existing job and queue duplicates). Chaining per provider makes the
// check+enqueue effectively atomic within this single-process backend — the
// second call waits, then finds the first's job and returns the same jobId.
const prepareEnqueueChain = new Map<string, Promise<unknown>>();

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
  const eps = b.endpoints?.endpoints ?? [];
  return {
    id: b.id,
    projectId: hashProjectPath(root),
    repo: path.basename(root),
    branch: b.gitWorktrees?.[0]?.branch ?? b.cloud?.workspaceBranch ?? '',
    // A user-set display label (via rename) wins over the live agent session
    // title as the box's primary label; else fall back to the session title, then name.
    task:
      b.displayName?.trim() ||
      b.claudeSessionTitle ||
      b.codexSessionTitle ||
      b.opencodeSessionTitle ||
      b.name,
    displayName: b.displayName?.trim() || null,
    // Normalize the frozen wire spelling ('claude-code') to the UI label ('claude').
    agent: normalizeLastAgent(b.lastAgent) ?? 'claude',
    status,
    createdAt,
    lastActivity: createdAt,
    host: hostLabel(b),
    provider: b.provider ?? 'docker',
    commits: null,
    filesTouched: null,
    error: status === 'error' ? (b.claudeSessionTitle ?? 'Agent reported an error') : null,
    webUrl: eps.find((e) => e.kind === 'web')?.url ?? null,
    vncUrl: eps.find((e) => e.kind === 'vnc')?.url ?? null,
    // Raw host-side fields for native clients (tray) — see Box for semantics.
    state: b.state,
    name: b.name,
    projectRoot: root,
    projectIndex: b.projectIndex,
    vncEnabled: b.vncEnabled ?? false,
    gitWorktrees: b.gitWorktrees?.map((w) => ({ kind: w.kind, branch: w.branch })),
    claudeSessionTitle: b.claudeSessionTitle,
    codexSessionTitle: b.codexSessionTitle,
    opencodeSessionTitle: b.opencodeSessionTitle,
    claudeActivity: b.claudeActivity,
    codexActivity: b.codexActivity,
  };
}

/**
 * A box the control box knows only from its Store registry — created from a PC
 * (or another host) that registered it here but whose `state.json` this VPS
 * doesn't have. Without this the hub's own web UI + `/api/v1/boxes` (and so the
 * tray) list only boxes the control box created locally, hiding every
 * PC-registered box the Store plainly holds. The mirror of the PC's
 * `mergeHubBoxes`: surface it, from the registration alone.
 *
 * A live status the box pushed (via the plane's status store) is used when
 * present; otherwise it shows `running`, since a registration means the box
 * exists. Lifecycle actions on these rows are a follow-up — the control box has
 * no local record to drive them yet.
 */
/**
 * The synthetic project a registered box groups under. The box row and this
 * project MUST share the id, or the dashboard counts the box but renders it
 * under no project card (it groups strictly by `projectId`).
 *
 * Keyed by the box's HOST FOLDER (`worktrees[].hostMainRepo`, the PC path the
 * box was created from) — the same key `agentbox ls` uses locally
 * (`hashProjectPath(projectRoot)`). So a PC box groups by its folder, not its
 * repo: two folders that share a git origin stay separate (matching the local
 * model), and the id matches the box's own local project, so adopting it on the
 * PC lands it in the same card rather than a duplicate.
 *
 * Falls back to the repo identity only when there's no host folder (e.g. a
 * hub-worker box whose temp clone was deleted — those normally render from
 * local state, not here).
 */
function registrationProjectKey(reg: BoxRegistration): { id: string; repo: string } {
  const hostFolder = reg.worktrees?.[0]?.hostMainRepo;
  if (hostFolder && hostFolder.startsWith('/')) {
    return { id: hashProjectPath(hostFolder), repo: path.basename(hostFolder) };
  }
  const repo = reg.projectSlug ?? (reg.originUrl ? deriveRepoLabel(reg.originUrl) : reg.name);
  return { id: hashProjectPath(repo), repo };
}

function mapRegistrationToBox(reg: BoxRegistration): Box {
  const createdAt = Date.parse(reg.createdAt ?? reg.registeredAt) || Date.now();
  const { id: projectId, repo: repoKey } = registrationProjectKey(reg);
  return {
    id: reg.boxId,
    projectId,
    repo: repoKey,
    branch: reg.worktrees?.[0]?.branch ?? '',
    task: reg.name,
    displayName: null,
    agent: normalizeLastAgent(reg.agent as BoxRecord['lastAgent']) ?? 'claude',
    status: 'running',
    createdAt,
    lastActivity: createdAt,
    host: `${reg.backend ?? 'cloud'} · registered`,
    provider: reg.backend ?? 'cloud',
    commits: null,
    filesTouched: null,
    error: null,
    webUrl: null,
    vncUrl: null,
    state: 'running',
    name: reg.name,
    projectIndex: reg.projectIndex,
  };
}

/** A short repo label from an origin URL: `owner/repo`, else the last path segment. */
function deriveRepoLabel(originUrl: string): string {
  const m = /[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(originUrl);
  return m?.[1] ?? originUrl;
}

/**
 * A host repo's current branch (`git rev-parse --abbrev-ref HEAD`). Returns null when
 * HEAD is detached (git prints the literal `HEAD`), the path isn't a repo, or git fails.
 * Uses node's built-in execFile to avoid pulling execa into the Next-adjacent module.
 */
async function hostBranchOf(repo: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = stdout.trim();
    return !branch || branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Whether a new box in this project would want the setup wizard: the host repo
 * has no `agentbox.yaml` AND no default snapshot (per-provider or global). A
 * snapshot carries the yaml, so a project with one doesn't need setup even
 * without a host file. Best-effort — any error means "don't offer setup". One
 * `loadEffectiveConfig` per project (few of them), so cheap enough for getData().
 */
async function computeNeedsSetup(root: string, provider: string): Promise<boolean> {
  try {
    const cfg = await loadEffectiveConfig(root);
    if (cfg.hasAgentboxYaml) return false;
    return resolveDefaultCheckpoint(cfg.effective, provider).length === 0;
  } catch {
    return false;
  }
}

/**
 * The control box this hub operates through (`relay.controlPlaneUrl`), or null.
 * Present on the PC's localhost hub; the control box's own hub leaves the key
 * unset, so it correctly reports no control box (it IS one). Best-effort.
 */
async function readControlPlane(): Promise<{ url: string } | null> {
  try {
    const cfg = await loadEffectiveConfig(os.homedir());
    const url = (cfg.effective.relay.controlPlaneUrl ?? '').replace(/\/$/, '');
    return url ? { url } : null;
  } catch {
    return null;
  }
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
  // The host path per project id, so we can read each repo's current branch below.
  const pathById = new Map<string, string>();
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
    pathById.set(e.hash, e.originalPath);
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
      pathById.set(id, p.root);
    }
  }
  // Read each host repo's current branch (the base a new box forks from). Runs on every
  // state read, so keep it a single cheap `rev-parse` per project, in parallel.
  await Promise.all(
    [...byId.entries()].map(async ([id, proj]) => {
      const repo = pathById.get(id);
      if (!repo) return;
      [proj.currentBranch, proj.needsSetup] = await Promise.all([
        hostBranchOf(repo),
        computeNeedsSetup(repo, proj.provider),
      ]);
    }),
  );
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
    provider: job.providerName ?? 'docker',
    commits: null,
    filesTouched: null,
    error: status === 'error' ? (job.reason ?? 'create failed') : null,
    // Raw host-side fields so native clients can group/label the synthetic row.
    // `state` is deliberately absent — that's the synthetic-box marker.
    name: job.boxName,
    projectRoot: root,
  };
}

/**
 * Which providers a box can be created on right now. docker is always available
 * (its base self-heals); a cloud provider is usable only once its base is baked —
 * `~/.agentbox/<provider>-prepared.json` with a `base`. That marker read is sync +
 * offline (no cloud SDK), so it's cheap to compute on every getData(). A prepared
 * marker implies a prior `<provider> login`, so it's a sufficient readiness proxy.
 */
// remote-docker keeps no single base image — it's a set of SSH host aliases in
// `~/.agentbox/remote-docker-hosts.json`, each baked (or lazily built) on its own.
// A direct sync read (mirrors readPreparedStateRaw/readSecretsKeys) keeps the hot
// `listProviders` path off the remote-docker package's dynamic import.
function remoteDockerHostCount(): number {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(os.homedir(), '.agentbox', 'remote-docker-hosts.json'), 'utf8'),
    ) as { hosts?: Record<string, unknown> };
    return raw.hosts && typeof raw.hosts === 'object' ? Object.keys(raw.hosts).length : 0;
  } catch {
    return 0;
  }
}

function isProviderConfigured(id: ProviderKind): boolean {
  if (id === 'docker') return true;
  // remote-docker is usable as soon as one host alias is registered (the image
  // builds lazily on first create); it never writes a top-level `base` marker.
  if (id === 'remote-docker') return remoteDockerHostCount() > 0;
  const raw = readPreparedStateRaw(id);
  return !!(raw && typeof raw === 'object' && (raw as { base?: unknown }).base);
}

// secrets.env key(s) whose presence means a provider has credentials. Checked by
// name only (never the value) so credential status is cheap + SDK-free. docker
// needs none.
const PROVIDER_CRED_KEYS: Record<ProviderKind, readonly string[]> = {
  docker: [],
  e2b: ['E2B_API_KEY'],
  daytona: ['DAYTONA_API_KEY', 'DAYTONA_JWT_TOKEN'],
  hetzner: ['HCLOUD_TOKEN'],
  vercel: ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'VERCEL_AUTH_SOURCE'],
  digitalocean: ['DIGITALOCEAN_TOKEN'],
  // remote-docker authenticates as you, over your own ~/.ssh/config — there is
  // no credential to store, so there is none to check.
  'remote-docker': [],
};

/** Set of KEY names present in `~/.agentbox/secrets.env` (values ignored). */
function readSecretsKeys(): Set<string> {
  const out = new Set<string>();
  let body = '';
  try {
    body = readFileSync(secretsEnvPath(), 'utf8');
  } catch {
    return out;
  }
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq > 0) out.add(stripped.slice(0, eq).trim());
  }
  return out;
}

/** Whether a provider has credentials configured (secrets.env or the shell env). */
function hasProviderCredentials(id: ProviderKind, keys: Set<string>): boolean {
  if (id === 'docker') return true;
  return PROVIDER_CRED_KEYS[id].some((k) => keys.has(k) || !!process.env[k]);
}

/** Cheap `docker info` reachability probe (short timeout) for the bake precheck. */
async function dockerDaemonReachable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether an executable is on PATH (used to precheck hetzner's ssh/scp). */
async function binOnPath(name: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [name], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Host-side prechecks before enqueuing a bake, so an unmet prerequisite fails
 * fast with a clear message instead of a confusing mid-bake error. Returns an
 * error string when unmet, else null.
 */
async function preparePrecheck(id: ProviderKind): Promise<string | null> {
  if (id === 'docker') {
    return (await dockerDaemonReachable())
      ? null
      : 'Docker daemon is not reachable on this host — start Docker and try again.';
  }
  // Cloud providers need credentials first.
  if (!hasProviderCredentials(id, readSecretsKeys())) {
    return `No credentials for ${id} — add them before baking.`;
  }
  if (id === 'hetzner') {
    const [ssh, scp] = await Promise.all([binOnPath('ssh'), binOnPath('scp')]);
    if (!ssh || !scp) {
      return 'Hetzner baking needs the OpenSSH client (`ssh`/`scp`) on the host — install it and retry.';
    }
  }
  return null;
}

function listProviders(jobs: QueueJob[]): ProviderOption[] {
  const keys = readSecretsKeys();
  return PROVIDER_NAMES.map((id) => {
    // Keep "Docker (local)" but drop the "(cloud …)" qualifier from cloud labels
    // — the picker just wants the provider name.
    const label = id === 'docker' ? providerMeta(id).label : providerMeta(id).label.replace(/\s*\(.*\)$/, '');
    const configured = isProviderConfigured(id);
    const hasCredentials = hasProviderCredentials(id, keys);
    // An in-flight bake for this provider (queued or running) — lets the UI show
    // a live progress stream and disable a second bake.
    const bake = jobs.find(
      (j) =>
        j.kind === 'prepare' &&
        j.providerName === id &&
        (j.status === 'queued' || j.status === 'running'),
    );
    let reason: string | undefined;
    if (!configured) {
      reason =
        id === 'remote-docker'
          ? 'Add a host in Settings to run boxes on your own machine over SSH.'
          : hasCredentials
            ? 'Credentials set — bake the base image to finish setup.'
            : 'Not set up — add credentials, then bake the base image.';
    }
    return { id, label, configured, hasCredentials, jobId: bake?.id, reason };
  });
}

// ── base-image freshness (opt-in; kept OFF the getData() hot path) ──
// Computing a provider's live fingerprint loads its module and hashes the
// runtime build context (~15 small files) — cheap but not free, and pointless
// on every poll. We memoize the LIVE fingerprint per provider with a short TTL,
// so the frequently-read `GET /api/v1/providers` stays fast and only the explicit
// `?freshness=1` request pays the cost. The cache is keyed by the STORED
// fingerprint (a cheap single-file read done every call): a completed bake
// rewrites `<provider>-prepared.json` → the stored fingerprint changes → the
// entry misses and recomputes, so a fresh bake is reflected immediately (no
// stale window from a TTL that outlives the bake — Bugbot #151).
const FRESHNESS_TTL_MS = 60_000;
const freshnessCache = new Map<ProviderKind, { at: number; stored: string; live: string | undefined }>();

/**
 * Live base-image/snapshot freshness for one provider, mirroring the CLI's
 * `evaluateBaseFreshness` (apps/cli/src/checkpoint-lookup.ts) but reusing the
 * hub's own provider `IMPORTERS`. Docker gets a real check too (unlike the
 * CLI, which lets `ensureImage` self-heal silently): the tray/web create
 * flows use `unprepared`/`stale` to announce the upcoming bake instead of
 * hiding a multi-minute build inside the create job. Any failure to compute
 * the live fingerprint degrades to 'unknown' (never a false 'stale').
 */
async function providerBaseFreshness(id: ProviderKind, claudeInstall?: 'native' | 'npm'): Promise<BaseStatus> {
  if (id === 'docker') {
    // Bypasses the cloud-fingerprint freshnessCache: the check is one
    // `docker image inspect` plus hashing the staged context files, and
    // freshness is only computed on the opt-in `?freshness=1` path.
    try {
      const { evaluateDockerBaseFreshness } = await import('@agentbox/sandbox-docker');
      return await evaluateDockerBaseFreshness({ claudeInstall });
    } catch {
      return { state: 'unknown' };
    }
  }
  // On a control box the bake record lives in custody, not local prepared-state
  // (which is empty until a create hydrates it). Adopt it here too — same
  // fingerprint-match-wins policy as the create path — so `/settings` reflects
  // shared bakes instead of showing every provider as "needs baking". No-op on a
  // local hub (local prepared-state already set) or when custody has no match.
  try {
    const mod = (await IMPORTERS[id]()).providerModule;
    await hydratePreparedFromCustody(new FsCustodyStore(), id, mod.provider, claudeInstall ?? 'native', () => {});
  } catch {
    // best-effort: fall through to whatever local prepared-state holds
  }
  const stored = currentCloudBaseFingerprint(id);
  const cached = freshnessCache.get(id);
  // Reuse the memoized LIVE fingerprint only while both the stored fingerprint
  // and the TTL still hold — a re-bake changes `stored` and invalidates it.
  let live: string | undefined;
  if (cached && cached.stored === (stored ?? '') && Date.now() - cached.at < FRESHNESS_TTL_MS) {
    live = cached.live;
  } else {
    try {
      const mod = (await IMPORTERS[id]()).providerModule;
      live = await mod.currentBaseFingerprintLive?.(claudeInstall);
    } catch {
      live = undefined;
    }
    freshnessCache.set(id, { at: Date.now(), stored: stored ?? '', live });
  }
  return baseFreshnessFromFingerprints(stored, live);
}

/**
 * Enrich the provider list with base-image freshness (`baseStatus`/
 * `baseStaleReason`). Global-scoped `claudeInstall` (staleness is approximate
 * nagging; `listProviders` is project-independent) resolved from the global
 * effective config, defaulting to 'native'.
 */
async function listProvidersWithFreshness(base: ProviderOption[]): Promise<ProviderOption[]> {
  let claudeInstall: 'native' | 'npm' = 'native';
  try {
    const cfg = await loadEffectiveConfig(os.homedir());
    if (cfg.effective.box.claudeInstall === 'npm') claudeInstall = 'npm';
  } catch {
    // keep the default
  }
  return Promise.all(
    base.map(async (p) => {
      if (!isProviderKind(p.id)) return p;
      const fresh = await providerBaseFreshness(p.id, claudeInstall);
      return {
        ...p,
        baseStatus: fresh.state,
        baseStaleReason: fresh.state === 'stale' ? fresh.reason : undefined,
      };
    }),
  );
}

/** The registered remote-docker host aliases as create/settings-facing views. */
async function loadRemoteDockerHostViews(): Promise<RemoteDockerHostView[]> {
  const rd = await import('@agentbox/sandbox-remote-docker');
  const prepared = rd.readPreparedState();
  const cfg = await loadEffectiveConfig(os.homedir());
  const dflt = (cfg.effective.box.remoteDockerHost || '').trim();
  return rd.listHostAliases().map(({ alias, entry }) => {
    const baked = prepared?.hosts[alias];
    return {
      alias,
      ssh: entry.ssh,
      baked: Boolean(baked),
      ...(baked ? { bakedImageRef: baked.imageRef } : {}),
      default: alias === dflt,
    };
  });
}

/**
 * For the create pickers only: replace the single `remote-docker` provider entry
 * with one `docker:<alias>` option per registered host, so a user can create a box
 * on a specific machine. Keeps the single entry (guiding to Settings) when there
 * are no hosts. Settings never asks for this — it renders one Remote Docker row and
 * nests the hosts itself.
 */
async function expandRemoteDockerHosts(base: ProviderOption[]): Promise<ProviderOption[]> {
  const idx = base.findIndex((p) => p.id === 'remote-docker');
  if (idx < 0) return base;
  const hosts = await loadRemoteDockerHostViews();
  if (hosts.length === 0) return base;
  const perHost: ProviderOption[] = hosts.map((h) => ({
    // id stays the `docker:<alias>` create spec; the label reads like "Docker (local)".
    id: `docker:${h.alias}`,
    label: `Docker (${h.alias})`,
    configured: true,
    hasCredentials: true,
    reason: h.baked
      ? undefined
      : 'Image builds on first create — bake it in Settings for a faster start.',
  }));
  return [...base.slice(0, idx), ...perHost, ...base.slice(idx + 1)];
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

const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Cap on-demand git network calls so a private-remote credential prompt can't hang the request. */
const GIT_NET_TIMEOUT_MS = 15_000;

/**
 * List a host repo's branches (local heads + remote-tracking) plus the current
 * HEAD, for the create-box base-branch picker. Best-effort `fetch --all` first
 * so remote tips are current; `origin/HEAD` (a symref) is dropped. All via node
 * execFile (no execa in this Next-adjacent module), mirroring `hostBranchOf`.
 */
async function branchListHost(repo: string): Promise<BranchList> {
  try {
    await execFileAsync('git', ['-C', repo, 'fetch', '--quiet', '--all'], {
      timeout: GIT_NET_TIMEOUT_MS,
    }).catch(() => {});
    const { stdout } = await execFileAsync('git', [
      '-C',
      repo,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
      'refs/remotes',
    ]);
    const seen = new Set<string>();
    const branches: string[] = [];
    for (const raw of stdout.split('\n')) {
      const b = raw.trim();
      if (!b || b.endsWith('/HEAD')) continue;
      if (seen.has(b)) continue;
      seen.add(b);
      branches.push(b);
    }
    return { ok: true, current: await hostBranchOf(repo), branches };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validate a `--from-branch` ref against the host repo before enqueuing a create
 * job — a typo shouldn't leave a half-built box. Mirrors `resolveFromBranch`
 * (apps/cli): fetch branch/tag names first (SHAs skip the fetch), then
 * `rev-parse --verify <ref>^{commit}`. Node execFile, not execa.
 */
async function verifyFromBranch(repo: string, ref: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!SHA_RE.test(ref)) {
    await execFileAsync('git', ['-C', repo, 'fetch', '--quiet', 'origin', ref], {
      timeout: GIT_NET_TIMEOUT_MS,
    }).catch(() => {});
  }
  const ok = await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`])
    .then(() => true)
    .catch(() => false);
  return ok ? { ok: true } : { ok: false, error: `unknown base ref "${ref}" (not found in the project repo)` };
}

/** Reverse-adoption seam: reconstruct + persist a local record from a Store registration. */
type HydrateFn = (id: string) => Promise<BoxRecord | null>;

/**
 * Materialize a box's per-box SSH key from the control box's local custody into
 * the on-disk ssh dir the provider exec/git path reads. Best-effort: SDK
 * providers (e2b/vercel/daytona) mint no keypair (`boxSshDirForProvider` → null),
 * and a PC-created VPS box whose PC never pushed its key simply has none in
 * custody — lifecycle + destroy still work (cloud API), only git/exec over SSH
 * needs it.
 */
async function materializeBoxSshFromCustody(
  custody: CustodyStore | null | undefined,
  provider: string,
  sandboxId: string,
): Promise<void> {
  if (!custody) return;
  const dir = boxSshDirForProvider(provider, sandboxId);
  if (!dir) return;
  const entries = await custody.list(`boxes/${sandboxId}/ssh`).catch(() => []);
  if (entries.length === 0) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const e of entries) {
    const found = await custody.get(e.path).catch(() => null);
    if (!found) continue;
    const out = path.join(dir, path.basename(e.path));
    await writeFile(out, found.data, { mode: 0o600 });
    await chmod(out, 0o600);
  }
}

/**
 * Reverse-adopt a box the control box holds only as a Store registration (created
 * on a PC / another host, never locally): rebuild a drivable `BoxRecord` via the
 * shared `registrationToBoxRecord` — the mirror of the PC's `hub adopt` — pull its
 * SSH key from local custody, and persist it to `state.json`. Returns null when
 * there is no registration or the provider can't be resolved (unknown kind /
 * missing creds), so the caller reports "not found" or falls back to a state-only
 * reap exactly as before. Idempotent: once recorded, a second call finds it in
 * local state and never reaches here.
 */
async function hydrateRegisteredBox(handle: RelayServerHandle, id: string): Promise<BoxRecord | null> {
  const reg = await handle.store.getBox(id).catch(() => undefined);
  if (!reg) return null;
  const record = registrationToBoxRecord(reg, {
    // The control box IS the control plane; persist its own public URL so the
    // record's topology matches a worker-created box's.
    controlPlaneUrl: process.env.AGENTBOX_HUB_PUBLIC_URL ?? '',
    freshToken: generateRelayToken,
  });
  // Only adopt a box we can actually drive: resolving the provider loads its
  // module + credentials, so a missing-cred / unknown-provider box returns null
  // rather than leaving behind a local record we can't act on.
  try {
    await providerForBox(record);
  } catch {
    return null;
  }
  await materializeBoxSshFromCustody(handle.custody, record.provider ?? 'docker', reg.sandboxId ?? id).catch(
    () => {},
  );
  await recordBox(record);
  return record;
}

/**
 * Reap a box's control-box Store state — registration, status snapshot, and
 * SSH-key custody subtree. Idempotent; returns whether a registration existed.
 * Used both after a real destroy (clear the now-dead registration) and as the
 * fallback when the cloud resource can't be driven (state cleanup only).
 */
async function reapStoreState(handle: RelayServerHandle, id: string): Promise<boolean> {
  const reg = await handle.store.getBox(id).catch(() => undefined);
  const existed = await handle.store.forgetBox(id).catch(() => false);
  await handle.store.deleteStatus(id).catch(() => {});
  if (handle.custody) {
    const key = reg?.sandboxId ?? id;
    const entries = await handle.custody.list(`boxes/${key}`).catch(() => []);
    for (const e of entries) await handle.custody.delete(e.path).catch(() => false);
  }
  return existed || reg !== undefined;
}

/**
 * Resolve a box id to its local `BoxRecord`, falling back to reverse-adoption:
 * a box the control box knows only from its Store registration (created on a PC
 * / another host) has no local `state.json` record, so `readState()` misses it.
 * `hydrate` reconstructs + persists that record on demand (see
 * `hydrateRegisteredBox`), after which every provider-driven path (lifecycle,
 * git, real destroy) finds it in state and Just Works.
 */
async function findOrHydrateBox(id: string, hydrate?: HydrateFn): Promise<BoxRecord | null> {
  const { boxes } = await readState();
  const local = boxes.find((b) => b.id === id);
  if (local) return local;
  return hydrate ? await hydrate(id) : null;
}

async function runLifecycle(
  id: string,
  op: (box: BoxRecord, provider: Provider) => Promise<void>,
  hydrate?: HydrateFn,
): Promise<ActionResult> {
  try {
    const box = await findOrHydrateBox(id, hydrate);
    if (!box) return { ok: false, error: `box ${id} not found` };
    const provider = await providerForBox(box);
    await op(box, provider);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Keep `~/.agentbox/ssh/config` in sync after a hub-initiated resume, so boxes
 * created/resumed through the hub get the same `ssh <box>` alias the CLI writes
 * (a Hetzner box's public IP can change across pause/resume). Best-effort and
 * gated by `ssh.autoConfig`; the hub runs on the host, so it can write the file.
 */
async function hubWriteSshConfig(box: BoxRecord, provider: Provider): Promise<void> {
  try {
    const cfg = await loadEffectiveConfig(box.workspacePath);
    await autoWriteSshConfig(box, provider, cfg.effective.ssh.autoConfig, (m) =>
      console.warn(`[hub] ${m}`),
    );
  } catch (err) {
    console.warn(`[hub] ssh-config write for ${box.name} failed: ${errMsg(err)}`);
  }
}

/** Resolve a box id to its record + provider, or null when the box is gone. */
async function resolveBoxProvider(
  id: string,
  hydrate?: HydrateFn,
): Promise<{ box: BoxRecord; provider: Provider } | null> {
  const box = await findOrHydrateBox(id, hydrate);
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
async function gitOp(
  id: string,
  fn: (box: BoxRecord, provider: Provider) => Promise<ExecResult>,
  hydrate?: HydrateFn,
): Promise<BoxOpResult> {
  try {
    const rp = await resolveBoxProvider(id, hydrate);
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

// ── host "open in" launchers ──
// These re-shell the installed CLI (`agentbox open ...`), which owns the SSH
// alias / codex:// deep link / terminal-spawn / IDE-launch logic — the same
// pattern the relay uses for cp/checkpoint host actions (host-actions.ts). They
// launch host GUI apps, so they only work on a localhost hub on macOS.

/** Whether this hub can launch host GUI apps: the user's own Mac, not a remote profile. */
function canOpenInHostApps(): boolean {
  return hubProfile() === 'localhost' && process.platform === 'darwin';
}

/**
 * Turn an execFile rejection from a re-shelled `agentbox` command into a
 * human-readable error. The CLI reports failures through clack `log.error`,
 * which lands on stdout wrapped in gutter glyphs and ANSI codes, so prefer
 * stdout over stderr, strip the decoration, and drop empty lines.
 */
function cleanCliError(e: { stderr?: string; stdout?: string; message?: string }): string {
  const raw = e.stdout?.trim() || e.stderr?.trim() || e.message || 'command failed';
  const cleaned = raw
    .replace(/[\u0000-\u001f]+/g, '\n') // ANSI/control bytes (incl. ESC) -> line breaks
    .replace(/\[[0-9;]*m/g, '') // leftover ANSI colour codes
    .split('\n')
    .map((line) => line.replace(/^[^\p{L}\p{N}'"(]+/u, '').trim()) // drop leading gutter glyphs/punct
    .filter((line) => line.length > 0)
    .join(' ');
  return cleaned || 'command failed';
}

// Cache the target probe: it spawns a `node` process (`open --targets`), and app
// installs change rarely, so a page load shouldn't re-spawn it every time.
const OPEN_TARGETS_TTL_MS = 60_000;
let openTargetsCache: { at: number; value: OpenTargetsReport } | null = null;

/** Probe installed host apps via the CLI's `open --targets --json` (cached). */
async function probeOpenTargets(): Promise<OpenTargetsReport | null> {
  const now = Date.now();
  if (openTargetsCache && now - openTargetsCache.at < OPEN_TARGETS_TTL_MS) {
    return openTargetsCache.value;
  }
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry) return null;
  try {
    const { stdout } = await execFileAsync(process.execPath, [entry, 'open', '--targets', '--json'], {
      timeout: 10_000,
    });
    const value = JSON.parse(stdout) as OpenTargetsReport;
    openTargetsCache = { at: now, value };
    return value;
  } catch {
    return null;
  }
}

export function createHubBackend(handle: RelayServerHandle): HubBackend {
  // Reverse-adoption: drive a box the control box knows only from its Store
  // registration (PC-created / independent) by reconstructing its local record on
  // demand. Threaded into every provider-driven path below.
  const hydrate: HydrateFn = (bid) => hydrateRegisteredBox(handle, bid);
  return {
    // authMode is layered on by source.ts (an env-derived concern), so the host
    // backend produces everything else.
    async getData(): Promise<Omit<HubState, 'authMode'>> {
      const [listed, jobs] = await Promise.all([listBoxes(), loadQueue()]);
      // Surface in-flight create jobs as synthetic `creating` boxes (and just-
      // failed ones as `error`) until the real box lands in listBoxes() and
      // takes over — matched by the boxId the worker writes back to the manifest.
      const liveIds = new Set(listed.map((b) => b.id));
      const liveSandboxIds = new Set(
        listed.map((b) => b.cloud?.sandboxId).filter((s): s is string => Boolean(s)),
      );
      const jobBoxes: Box[] = [];
      for (const j of jobs) {
        // A prepare (image-bake) job produces an artifact, not a box — it never
        // surfaces in the box list (its progress is provider status instead).
        if (j.kind === 'prepare') continue;
        if (j.boxId && liveIds.has(j.boxId)) continue;
        if (j.status === 'queued' || j.status === 'running') jobBoxes.push(mapJobToBox(j, 'creating'));
        else if (j.status === 'failed') jobBoxes.push(mapJobToBox(j, 'error'));
      }
      // Boxes the Store holds but this VPS's local state doesn't — i.e.
      // registered from a PC. Deduped by box id AND sandbox id (a box the
      // control box created locally is in both, under possibly different ids).
      const registered = (await handle.store.listBoxes().catch(() => [])).filter(
        (r) => !liveIds.has(r.boxId) && !(r.sandboxId && liveSandboxIds.has(r.sandboxId)),
      );
      const registeredBoxes = registered.map(mapRegistrationToBox);
      // Each registered box needs a project to render under (the dashboard groups
      // strictly by projectId). Add a synthetic one per new project key not
      // already produced by listProjects — sharing the box row's id.
      const projects = await listProjects(listed);
      const projectIds = new Set(projects.map((p) => p.id));
      for (const reg of registered) {
        const { id, repo } = registrationProjectKey(reg);
        if (projectIds.has(id)) continue;
        projectIds.add(id);
        projects.push({
          id,
          name: repo,
          repo,
          defaultBranch: reg.worktrees?.[0]?.branch ?? 'main',
          provider: reg.backend ?? 'cloud',
          createdAt: Date.parse(reg.createdAt ?? reg.registeredAt) || Date.now(),
        });
      }
      return {
        user: currentUser(),
        github: LOCAL_GITHUB,
        projects,
        boxes: [...jobBoxes, ...listed.map(mapBox), ...registeredBoxes],
        // Block-mode approvals live in-process on the relay handle, not the Store.
        approvals: handle.prompts.all().map(mapApproval),
        providers: listProviders(jobs),
        controlPlane: await readControlPlane(),
      };
    },
    async providersWithFreshness(opts): Promise<ProviderOption[]> {
      const fresh = await listProvidersWithFreshness(listProviders(await loadQueue()));
      return opts?.expandRemoteDockerHosts ? expandRemoteDockerHosts(fresh) : fresh;
    },
    start: (id) =>
      runLifecycle(id, async (box, provider) => {
        // Mirrors the CLI dashboard's resumeBox: docker `start` rejects a paused
        // container, so probe first. No-op when already running (idempotent).
        // Unlike CLI `agentbox start` this does not restore agent tmux sessions
        // (restoreAgentSessions is CLI-only) — the agent restarts on next attach.
        const state = await provider.probeState(box);
        if (state === 'running') return;
        if (state === 'paused') await provider.resume(box);
        else await provider.start(box);
        // Refresh the box's SSH-config alias now it's back online (IP may have changed).
        await hubWriteSshConfig(box, provider);
      }, hydrate),
    pause: (id) => runLifecycle(id, (box, provider) => provider.pause(box), hydrate),
    resume: (id) =>
      runLifecycle(id, async (box, provider) => {
        await provider.resume(box);
        // Refresh the box's SSH-config alias now it's back online (IP may have changed).
        await hubWriteSshConfig(box, provider);
      }, hydrate),
    stop: (id) => runLifecycle(id, (box, provider) => provider.stop(box), hydrate),
    screen: (id) =>
      runLifecycle(id, async (box, provider) => {
        // The open-VNC prep step: mirror `agentbox screen` so the viewer shows
        // the box's web app, not a blank X desktop. Browser-launch failures are
        // logged, not thrown — the viewer URL still works without it.
        if ((box.provider ?? 'docker') === 'docker') {
          const br = await ensureBoxBrowserShowingApp(box);
          if (!br.up) console.warn(`[hub] screen ${box.name}: in-box browser failed: ${br.reason ?? 'unknown'}`);
        } else {
          const br = await openWebAppOnVncScreen(box, provider);
          if (!br.opened && br.reason && br.reason !== 'no web service') {
            console.warn(`[hub] screen ${box.name}: in-box browser failed: ${br.reason}`);
          }
        }
      }, hydrate),
    async destroy(id): Promise<ActionResult> {
      // A synthetic `job:` box is a failed create with no real container — "destroy"
      // it by clearing its queue manifest (what the tray/UI Dismiss action hits).
      if (id.startsWith('job:')) {
        // Mirror runLifecycle's contract: a thrown fs error becomes { ok:false, error }.
        try {
          const jobId = id.slice('job:'.length);
          const job = await readJob(jobId);
          if (!job) return { ok: true }; // already gone — idempotent
          if (job.status !== 'failed' && job.status !== 'cancelled' && job.status !== 'done') {
            return { ok: false, error: 'box is still being created; dismiss is not available yet' };
          }
          await deleteJob(jobId);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errMsg(err) };
        }
      }
      // `hydrate` reverse-adopts a registration-only box (PC-created / worker-
      // created whose temp clone was cleaned) so `provider.destroy` tears down the
      // REAL cloud resource — not just a state reap. Then reap the now-dead Store
      // registration + custody regardless (idempotent; also cleans up a
      // locally-created box's lingering registration).
      const local = await runLifecycle(id, async (box, provider) => {
        await provider.destroy(box);
        // Drop the destroyed box's `~/.agentbox/ssh/config` block (regenerate from state).
        await syncAgentboxSshConfig().catch(() => {});
      }, hydrate);
      const reaped = await reapStoreState(handle, id);
      if (local.ok) return { ok: true };
      // Real destroy couldn't run (no creds / provider unresolvable). If a
      // registration was reaped, the box is gone from the control box's view —
      // report success; otherwise surface the original "not found"/error.
      return reaped ? { ok: true } : local;
    },
    async rename(id, displayName): Promise<ActionResult> {
      // Pure state mutation — no provider round-trip. Empty/blank clears the label.
      // Enforce the same 60-char cap the CLI + REST route apply here, so the web
      // server action (which calls this directly, bypassing parseRenameBox) can't
      // persist an over-long label.
      try {
        if (displayName.trim().length > DISPLAY_NAME_MAX) {
          return { ok: false, error: `name too long (max ${DISPLAY_NAME_MAX} chars)` };
        }
        const { boxes } = await readState();
        const box = boxes.find((b) => b.id === id);
        if (!box) return { ok: false, error: `box ${id} not found` };
        await setBoxDisplayName(id, displayName);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
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
        const provider = (input.provider ?? 'docker').trim();
        // A host-qualified `docker:<alias>` / `remote-docker:<alias>` spec targets a
        // registered remote-docker host — validate the alias (the worker parses the
        // spec out of providerName). Bare names take the configured-provider gate.
        const hostSpec = provider.match(/^(?:docker|remote-docker):(.+)$/);
        if (hostSpec) {
          const alias = hostSpec[1];
          const rd = await import('@agentbox/sandbox-remote-docker');
          if (!rd.getHostAlias(alias)) {
            return { ok: false, error: `unknown remote-docker host '${alias}' — add it in Settings` };
          }
        } else {
          if (!isProviderKind(provider)) return { ok: false, error: `unknown provider ${provider}` };
          if (!isProviderConfigured(provider)) {
            return { ok: false, error: `provider ${provider} is not set up on this host` };
          }
        }
        const noAgent = input.agent === 'none';
        // For a no-agent box `agent` is inert (the worker ignores it when noAgent);
        // keep a valid placeholder so the closed QueueAgentKind union holds.
        const agent: QueueAgentKind =
          input.agent === 'claude' || input.agent === 'none' ? 'claude-code' : input.agent;
        const name = input.name?.trim() || undefined;
        // Base ref for the box's per-box branch (else HEAD). Validate against the
        // host repo up front so a typo fails here, not mid-build.
        const fromBranch = input.fromBranch?.trim() || undefined;
        if (fromBranch) {
          const v = await verifyFromBranch(workspace, fromBranch);
          if (!v.ok) return { ok: false, error: v.error };
          // Cloud providers seed via `git clone --branch <ref>`, which only accepts
          // branch/tag names — a SHA passes rev-parse but fails at provisioning, so
          // reject it here rather than leave a half-built box.
          if (provider !== 'docker' && SHA_RE.test(fromBranch)) {
            return {
              ok: false,
              error: `base ref "${fromBranch}" is a commit SHA; ${provider} boxes can only branch from a branch or tag name`,
            };
          }
        }
        // Setup wizard: seed the agent's first turn to generate agentbox.yaml.
        // Inert for a no-agent box (nothing to run it).
        const setupWizard = !noAgent && input.setupWizard === true;
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
          ...(setupWizard ? { setupWizard: true } : {}),
          createOpts: { workspace, name, fromBranch },
        });
        handle.pokeQueue();
        return { ok: true, jobId: job.id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async setProviderCredentials(id, fields): Promise<ActionResult> {
      try {
        if (!isProviderKind(id)) return { ok: false, error: `unknown provider ${id}` };
        if (id === 'docker') return { ok: true }; // docker needs no credentials
        const mod = (await IMPORTERS[id]()).providerModule;
        if (!mod.setCredentials) {
          return { ok: false, error: `provider ${id} does not support credential setup` };
        }
        const res = await mod.setCredentials(fields);
        // Never surface secret values; only ok/error.
        return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'invalid credentials' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    prepareProvider(id, opts): Promise<CreateBoxResult> {
      if (!isProviderKind(id)) return Promise.resolve({ ok: false, error: `unknown provider ${id}` });
      // Serialize per provider so concurrent POSTs can't both miss the in-flight
      // job and enqueue duplicates (the check+enqueue below isn't atomic on its own).
      const prev = prepareEnqueueChain.get(id) ?? Promise.resolve();
      const run = prev.then(async (): Promise<CreateBoxResult> => {
        try {
          // One bake per provider at a time — reuse the in-flight job if present.
          const existing = (await loadQueue()).find(
            (j) =>
              j.kind === 'prepare' &&
              j.providerName === id &&
              (j.status === 'queued' || j.status === 'running'),
          );
          if (existing) return { ok: true, jobId: existing.id };
          const precheck = await preparePrecheck(id);
          if (precheck) return { ok: false, error: precheck };
          const { job } = await enqueuePrepareJob({
            providerName: id,
            force: opts?.force,
            claudeInstall: opts?.claudeInstall,
          });
          handle.pokeQueue();
          return { ok: true, jobId: job.id };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });
      // Keep the chain alive for the next call without letting a rejection break it.
      prepareEnqueueChain.set(id, run.catch(() => {}));
      return run;
    },
    async listBranches(projectId: string): Promise<BranchList> {
      const repo = await resolveProjectPath(projectId);
      if (!repo) return { ok: false, error: `unknown project ${projectId}` };
      return branchListHost(repo);
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
            j.kind !== 'prepare' && // a bake isn't a project box
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
    async getJob(id) {
      const job = await readJob(id);
      if (!job) return null;
      // Surface the worker-written login sub-state (the inbound code rides a
      // separate file, never the manifest).
      const login = job.login
        ? {
            required: job.login.required,
            phase: job.login.phase,
            url: job.login.url,
            error: job.login.error,
            lastError: job.login.lastError,
          }
        : undefined;
      return { status: job.status, logPath: job.logPath, boxId: job.boxId, login };
    },
    async submitLoginCode(id, code) {
      const job = await readJob(id);
      if (!job) return { ok: false, error: `job not found: ${id}` };
      // Deliver via the dedicated code file (worker reads+consumes it) — never a
      // manifest write, so it can't race the worker's `login` phase/url updates.
      await writeQueueLoginCode(id, code);
      return { ok: true };
    },

    // ── box git operations (delegate to the shared, provider-agnostic helpers) ──
    gitCheckout: (id, branch) => gitOp(id, (box, provider) => boxGitCheckout(provider, box, branch), hydrate),
    gitNewBranch: (id, input) =>
      gitOp(id, (box, provider) => boxGitNewBranch(provider, box, input.name, input.from), hydrate),
    gitPush: (id, input = {}) =>
      gitOp(id, (box, provider) => boxGitPush(provider, box, input, hubGitDeps(id)), hydrate),
    gitPull: (id, input = {}) =>
      gitOp(id, (box, provider) => boxGitPull(provider, box, input, hubGitDeps(id)), hydrate),
    gitPushHost: (id, input = {}) => gitOp(id, (box, provider) => boxGitPushHost(provider, box, input), hydrate),
    async getGit(id): Promise<GitInfo> {
      try {
        const rp = await resolveBoxProvider(id, hydrate);
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
      const rp = await resolveBoxProvider(id, hydrate).catch(() => null);
      if (!rp) return { source: 'unavailable', services: [], tasks: [], ports: [], error: `box ${id} not found` };
      const live = await liveServices(rp.provider, rp.box);
      if (live) return mapLiveServices(live);
      const snap = handle.statusStore.get(id);
      if (snap && isValidBoxStatus(snap)) return mapPersistedServices(snap as unknown as CtlBoxStatus);
      return { source: 'unavailable', services: [], tasks: [], ports: [] };
    },
    async restartService(id, name): Promise<BoxOpResult> {
      try {
        const rp = await resolveBoxProvider(id, hydrate);
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

    async openTargets(): Promise<OpenTargets> {
      if (!canOpenInHostApps()) return { supported: false, targets: null };
      return { supported: true, targets: await probeOpenTargets() };
    },

    async openIn(id, app: OpenInApp): Promise<ActionResult> {
      if (!canOpenInHostApps()) {
        return { ok: false, error: 'open-in actions require a local hub running on macOS' };
      }
      const entry = process.env['AGENTBOX_CLI_ENTRY'];
      if (!entry) return { ok: false, error: 'hub is missing AGENTBOX_CLI_ENTRY; cannot launch host apps' };
      try {
        // Re-shell `agentbox open <id> --in <app>` (routes vscode -> code, the
        // rest to their host-app launchers). It launches and returns; the timeout
        // guards against a hung launcher, not the app staying open.
        await execFileAsync(process.execPath, [entry, 'open', id, '--in', app], { timeout: 20_000 });
        return { ok: true };
      } catch (err) {
        // execFile rejects on non-zero exit. The CLI prints its real error via
        // clack (stdout, with gutter glyphs), not stderr — clean that up so the
        // UI shows the reason (e.g. the codex "only Hetzner boxes qualify" gate)
        // rather than execFile's generic "Command failed: node …".
        const e = err as { stderr?: string; stdout?: string; message?: string };
        return { ok: false, error: cleanCliError(e) };
      }
    },

    // ── remote-docker host aliases ──
    async listRemoteDockerHosts(): Promise<RemoteDockerHostView[]> {
      return loadRemoteDockerHostViews();
    },
    async addRemoteDockerHost(alias, ssh, opts): Promise<ActionResult> {
      try {
        const rd = await import('@agentbox/sandbox-remote-docker');
        const trimmedSsh = ssh.trim();
        if (!rd.isValidAlias(alias)) {
          return {
            ok: false,
            error: `invalid host alias "${alias}" — use a plain name (letters, digits, ., _, -; no @, :, /)`,
          };
        }
        if (!trimmedSsh) return { ok: false, error: 'SSH connection is required' };
        if (rd.getHostAlias(alias)) {
          return { ok: false, error: `host alias "${alias}" already exists` };
        }
        // Probe before saving so an unreachable host / missing docker is rejected.
        const probe = await rd.probeRemoteEngine(trimmedSsh);
        if (!probe.ok) return { ok: false, error: probe.error ?? `${trimmedSsh}: remote engine unusable` };
        rd.upsertHostAlias(alias, trimmedSsh);
        if (opts?.default) {
          await setConfigValue('global', 'box.remoteDockerHost', alias, os.homedir(), { raw: true });
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async removeRemoteDockerHost(alias) {
      try {
        const rd = await import('@agentbox/sandbox-remote-docker');
        rd.removeHostAlias(alias);
        rd.removePreparedHost(alias);
        // Clear the global default if it pointed at this alias.
        const cfg = await loadEffectiveConfig(os.homedir());
        if (cfg.layers.global.values.box?.remoteDockerHost === alias) {
          await unsetConfigValue('global', 'box.remoteDockerHost', os.homedir());
        }
        // Boxes whose sandbox id was baked against this alias are now unreachable.
        const { boxes } = await readState();
        const boxesAffected = boxes
          .filter(
            (b) =>
              b.provider === 'remote-docker' &&
              typeof b.cloud?.sandboxId === 'string' &&
              b.cloud.sandboxId.startsWith(`${alias}/`),
          )
          .map((b) => b.name);
        return { ok: true, boxesAffected };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async bakeRemoteDockerHost(alias): Promise<CreateBoxResult> {
      try {
        const rd = await import('@agentbox/sandbox-remote-docker');
        if (!rd.getHostAlias(alias)) return { ok: false, error: `no such host alias ${alias}` };
        // The `docker:<alias>` spec bakes THIS host (the worker parses it out).
        const spec = `docker:${alias}`;
        // Reuse an in-flight bake for the same host if present.
        const existing = (await loadQueue()).find(
          (j) =>
            j.kind === 'prepare' &&
            j.providerName === spec &&
            (j.status === 'queued' || j.status === 'running'),
        );
        if (existing) return { ok: true, jobId: existing.id };
        const { job } = await enqueuePrepareJob({ providerName: spec });
        handle.pokeQueue();
        return { ok: true, jobId: job.id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
