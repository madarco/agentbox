import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findProjectRoot,
  hashProjectPath,
  isProviderKind,
  listProjectsConfigured,
  registerProject,
  type ProviderKind,
} from '@agentbox/config';
import { normalizeLastAgent, type BoxRecord, type Provider } from '@agentbox/core';
import {
  enqueueQueueJob,
  loadQueue,
  readJob,
  type PendingApproval,
  type QueueAgentKind,
  type QueueJob,
  type RelayServerHandle,
} from '@agentbox/relay';
import type { ProviderModule } from '@agentbox/sandbox-core';
import { readState } from '@agentbox/sandbox-core';
import { listBoxes, type ListedBox } from '@agentbox/sandbox-docker';
import type {
  ActionResult,
  CreateBoxInput,
  CreateBoxResult,
  HubBackend,
} from './boxes/backend-types';
import type { Approval, Box, BoxStatus, GithubState, HubState, Project, User } from './boxes/types';

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
    agent: AGENT_LABEL[job.agent] ?? 'claude',
    status,
    createdAt,
    lastActivity: createdAt,
    host: `local · ${job.providerName}`,
    commits: null,
    filesTouched: null,
    error: status === 'error' ? (job.reason ?? 'create failed') : null,
  };
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
        const entry = (await listProjectsConfigured()).find((e) => e.hash === input.projectId);
        if (!entry) return { ok: false, error: `unknown project ${input.projectId}` };
        const agent: QueueAgentKind = input.agent === 'claude' ? 'claude-code' : input.agent;
        // Enqueue a detached create job (the same pipeline as `agentbox <agent>
        // -i`): the worker runs createBox() — including the full sync layer —
        // then starts the agent in a detached tmux session. It never attaches.
        const { job } = await enqueueQueueJob({
          agent,
          boxName: input.name ?? '',
          providerName: 'docker',
          prompt: input.prompt ?? '',
          agentArgs: [],
          createOpts: { workspace: entry.originalPath },
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
    async getJob(id): Promise<{ status: string; logPath: string; boxId?: string } | null> {
      const job = await readJob(id);
      if (!job) return null;
      return { status: job.status, logPath: job.logPath, boxId: job.boxId };
    },
  };
}
