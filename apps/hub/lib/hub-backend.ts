import os from 'node:os';
import path from 'node:path';
import { isProviderKind, type ProviderKind } from '@agentbox/config';
import { normalizeLastAgent, type BoxRecord, type Provider } from '@agentbox/core';
import type { PendingApproval, RelayServerHandle } from '@agentbox/relay';
import type { ProviderModule } from '@agentbox/sandbox-core';
import { readState } from '@agentbox/sandbox-core';
import { listBoxes, type ListedBox } from '@agentbox/sandbox-docker';
import type { ActionResult, HubBackend } from './boxes/backend-types';
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
function projectIdFor(root: string): string {
  return Buffer.from(root).toString('base64url');
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
  const root = b.projectRoot ?? b.workspacePath ?? b.id;
  const createdAt = Date.parse(b.createdAt) || Date.now();
  const status = mapStatus(b);
  return {
    id: b.id,
    projectId: projectIdFor(root),
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

function deriveProjects(boxes: ListedBox[]): Project[] {
  const byRoot = new Map<string, { root: string; provider: string; createdAt: number }>();
  for (const b of boxes) {
    const root = b.projectRoot ?? b.workspacePath ?? b.id;
    const createdAt = Date.parse(b.createdAt) || Date.now();
    const existing = byRoot.get(root);
    if (!existing) byRoot.set(root, { root, provider: b.provider ?? 'docker', createdAt });
    else if (createdAt < existing.createdAt) existing.createdAt = createdAt;
  }
  return [...byRoot.values()]
    .map((p) => ({
      id: projectIdFor(p.root),
      name: path.basename(p.root),
      repo: path.basename(p.root),
      defaultBranch: 'main',
      provider: p.provider,
      createdAt: p.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
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
      const listed = await listBoxes();
      return {
        user: currentUser(),
        github: LOCAL_GITHUB,
        projects: deriveProjects(listed),
        boxes: listed.map(mapBox),
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
  };
}
