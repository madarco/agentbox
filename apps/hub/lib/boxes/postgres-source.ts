import 'server-only';

import type { PostgresStore } from '@agentbox/relay/control-plane';
import { repoNameFromRegistration } from './project-name';
import type { Approval, Box, BoxStatus, HubState, Project } from './types';

/*
 * Hosted (Postgres) box source. Used by the `next start` deploy path (vercel /
 * hetzner-compose), where there is no in-process host backend — box state lives
 * in Postgres, written by the relay routes. Dynamically imports the relay's
 * PostgresStore so `pg` never enters the localhost bundle.
 */

// Loose views over the relay types (kept structural to avoid a runtime import of
// @agentbox/relay just for types in the Next bundle).
interface Registration {
  boxId: string;
  name: string;
  registeredAt: string;
  createdAt?: string;
  kind?: string;
  backend?: string;
  projectIndex?: number;
  worktrees?: { branch?: string }[];
  originUrl?: string;
  /** Custody `projects/<slug>` key (`owner__repo`) the box registered with. */
  projectSlug?: string;
  // Adoption / reconstruction fields (non-secret) carried on the registration.
  sandboxId?: string;
  publicHost?: string;
  image?: string;
  webPort?: number;
  agent?: string;
}
type Snapshot = Record<string, unknown>;
interface AgentState {
  state?: string;
  sessionRunning?: boolean;
  sessionTitle?: string;
}
interface PromptRow {
  ev: { id: string; message: string; detail?: string; defaultAnswer?: 'y' | 'n'; context?: { command?: string; cwd?: string; argv?: string[] } };
  createdAt: string;
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

/**
 * A readable project label — the repo's last path segment, matching the local
 * hub's `path.basename(projectRoot)`. Prefers the origin URL, then the custody
 * slug, then the box name. See `project-name.ts` for the shared derivation.
 */
function repoName(r: Registration): string {
  return repoNameFromRegistration({
    originUrl: r.originUrl,
    projectSlug: r.projectSlug,
    name: r.name,
  });
}

/** Project identity for grouping — the repo (origin) when known, else the box name. */
function projectKey(r: Registration): string {
  return b64url(r.originUrl ?? r.name);
}

function agents(s: Snapshot | undefined): { claude?: AgentState; codex?: AgentState; opencode?: AgentState } {
  return {
    claude: s?.claude as AgentState | undefined,
    codex: s?.codex as AgentState | undefined,
    opencode: s?.opencode as AgentState | undefined,
  };
}

function deriveStatus(s: Snapshot | undefined): BoxStatus {
  if (!s) return 'stopped';
  const { claude, codex, opencode } = agents(s);
  if ([claude?.state, codex?.state, opencode?.state].includes('error')) return 'error';
  const running = Boolean(claude?.sessionRunning || codex?.sessionRunning || opencode?.sessionRunning);
  return running ? 'running' : 'stopped';
}

function mapBox(r: Registration, s: Snapshot | undefined): Box {
  const { claude, codex, opencode } = agents(s);
  const createdAt = Date.parse(r.createdAt ?? r.registeredAt) || Date.now();
  return {
    id: r.boxId,
    projectId: projectKey(r),
    repo: repoName(r),
    branch: r.worktrees?.[0]?.branch ?? '',
    task: claude?.sessionTitle ?? codex?.sessionTitle ?? opencode?.sessionTitle ?? r.name,
    agent: codex?.sessionRunning ? 'codex' : opencode?.sessionRunning ? 'opencode' : 'claude',
    status: deriveStatus(s),
    createdAt,
    lastActivity: createdAt,
    host: r.backend ? `${r.kind ?? 'cloud'} · ${r.backend}` : (r.kind ?? 'cloud'),
    // Hosted source never offers host "open in" (remote hub) — value is informational.
    provider: r.kind ?? 'docker',
    commits: null,
    filesTouched: null,
    error: deriveStatus(s) === 'error' ? (claude?.sessionTitle ?? 'Agent reported an error') : null,
    // Hosted source has no endpoint data yet — cloud preview URLs are a follow-up.
    webUrl: null,
    vncUrl: null,
    // The registration's box name — populated on this topology too (the
    // in-process host source always sets it) so server-side ref resolution
    // (`GET /api/v1/boxes?ref=<name>`) matches by name here, not just by id.
    // `task` above is the display label (a session title when present), so it
    // is not a reliable name key.
    name: r.name,
    // Adoption / reconstruction fields from the registration (non-secret), so a
    // thin CLI can rebuild a drivable record from this payload.
    sandboxId: r.sandboxId,
    originUrl: r.originUrl,
    publicHost: r.publicHost,
    image: r.image,
    webPort: r.webPort,
    lastAgent:
      r.agent === 'claude' || r.agent === 'codex' || r.agent === 'opencode' ? r.agent : undefined,
    topology: 'control-plane',
  };
}

function deriveProjects(regs: Registration[]): Project[] {
  const byKey = new Map<
    string,
    { key: string; name: string; createdAt: number; originUrl?: string; projectSlug?: string }
  >();
  for (const r of regs) {
    const key = projectKey(r);
    const createdAt = Date.parse(r.createdAt ?? r.registeredAt) || Date.now();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { key, name: repoName(r), createdAt, originUrl: r.originUrl, projectSlug: r.projectSlug });
    } else {
      if (createdAt < existing.createdAt) existing.createdAt = createdAt;
      // A later registration may carry the git identity an earlier one lacked.
      existing.originUrl ??= r.originUrl;
      existing.projectSlug ??= r.projectSlug;
    }
  }
  return [...byKey.values()]
    .map((p) => ({
      id: p.key,
      name: p.name,
      repo: p.name,
      defaultBranch: 'main',
      provider: 'cloud',
      createdAt: p.createdAt,
      originUrl: p.originUrl ?? null,
      projectSlug: p.projectSlug ?? null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function mapApproval(boxId: string, row: PromptRow): Approval {
  return {
    id: row.ev.id,
    boxId,
    message: row.ev.message,
    detail: row.ev.detail,
    command: row.ev.context?.command,
    cwd: row.ev.context?.cwd,
    argv: row.ev.context?.argv,
    defaultAnswer: row.ev.defaultAnswer ?? 'n',
    createdAt: Date.parse(row.createdAt) || Date.now(),
  };
}

/** True when a hosted Postgres source should back the dashboard. */
export function hasPostgresSource(): boolean {
  return Boolean(process.env.POSTGRES_URL ?? process.env.RELAY_STORE_URL);
}

// One Postgres pool (+ one migrate) per server instance, not per dashboard load —
// PostgresStore creates its pool lazily on first query, so a new store per render
// would leak pools until the connection limit is hit. Mirrors lib/plane.ts.
let storePromise: Promise<PostgresStore> | null = null;
function getStore(url: string): Promise<PostgresStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const { PostgresStore } = await import('@agentbox/relay/control-plane');
      const store = new PostgresStore({ connectionString: url });
      await store.migrate();
      return store;
    })().catch((err: unknown) => {
      storePromise = null; // let the next request retry (e.g. transient DB outage)
      throw err;
    });
  }
  return storePromise;
}

export async function getPostgresDashboardData(): Promise<Omit<HubState, 'authMode'>> {
  const url = process.env.POSTGRES_URL ?? process.env.RELAY_STORE_URL;
  if (!url) throw new Error('hub: POSTGRES_URL required for the hosted source');
  const store = await getStore(url);

  const regs = (await store.listBoxes()) as unknown as Registration[];
  const statuses = await store.listStatuses();
  const statusByBox = new Map(statuses.map((s) => [s.boxId, s.status as Snapshot]));

  // Poll-mode approvals live in Postgres, one query per box (backlog is small).
  const approvals: Approval[] = [];
  for (const r of regs) {
    const pending = (await store.listPendingPrompts(r.boxId)) as unknown as PromptRow[];
    for (const row of pending) approvals.push(mapApproval(r.boxId, row));
  }

  return {
    user: { login: 'hub', name: 'hub' },
    github: { available: false, installed: false, appName: 'GitHub App', account: '', installedAt: 0, repos: [] },
    projects: deriveProjects(regs),
    boxes: regs.map((r) => mapBox(r, statusByBox.get(r.boxId))),
    approvals,
    // The hosted control box IS the control plane — it doesn't operate through
    // another one.
    controlPlane: null,
    // Provider readiness is host-local; the hosted/Postgres path has no create
    // host to probe (hosted create is a documented follow-up). Empty → the modal
    // falls back to docker-only.
    providers: [],
  };
}
