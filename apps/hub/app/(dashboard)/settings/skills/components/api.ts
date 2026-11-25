// Client-side types and fetch helper for the skills UI. The shapes mirror
// apps/hub/lib/backend/skills*.ts; they are restated here so the client bundle
// never pulls the backend modules (and @agentbox/sandbox-core) in.

export type SkillOrigin =
  | { kind: 'upload' }
  | { kind: 'folder'; linked: true; path: string; host?: string; machineId?: string }
  | { kind: 'git'; url: string; ref?: string; path?: string; commit: string }
  | {
      kind: 'marketplace';
      marketplace: string;
      url: string;
      ref?: string;
      plugin: string;
      commit: string;
    };

export type SkillPolicy = 'auto' | 'manual';

/** One row of `GET /api/v1/skills`. */
export interface SkillRow {
  name: string;
  description: string;
  current: string;
  size: number;
  files: number;
  tarballBytes: number;
  updatedAt: string;
  source: { host?: string; machineId?: string; path?: string };
  versions: number;
  origin?: SkillOrigin;
  policy?: SkillPolicy;
  pending?: { version: string; uploadedAt: string; size: number; files: number; commit?: string };
  /** The stored copy is unusable (e.g. cut short); a re-upload replaces it. */
  broken?: string;
}

export interface SkillsListing {
  seeded: boolean;
  skills: SkillRow[];
  /** Names marked "never sync" (`/api/v1/skill-skips`). */
  skipped?: string[];
}

export interface Finding {
  rule: string;
  path: string;
  line: number;
}

export interface SkillCandidate {
  name: string;
  description: string;
  path: string;
  size: number;
  files: number;
  problems: string[];
  findings: Finding[];
}

export interface AddResult {
  commit: string;
  candidates: SkillCandidate[];
  imported: { name: string; version: string; held: boolean }[];
  skipped: { name: string; reason: string }[];
}

export interface RefreshOutcome {
  name: string;
  status: 'up-to-date' | 'pending' | 'applied' | 'blocked' | 'failed' | 'not-refreshable';
  from?: string;
  to?: string;
  commit?: string;
  reason?: string;
}

export interface SkillDiffFile {
  path: string;
  status: 'added' | 'removed' | 'modified';
  modeOnly?: boolean;
  binary?: boolean;
  before?: string;
  after?: string;
}

export interface SkillDiff {
  name: string;
  from: string;
  to: string;
  files: SkillDiffFile[];
  /** Absent on a hub from before Phase 6. */
  findings?: Finding[];
}

export interface SkillMdRead {
  name: string;
  version: string;
  content: string;
  files: { path: string; size: number; mode: number }[];
}

/** `GET /api/v1/boxes/{id}/skills`. */
export interface BoxSkills {
  boxId: string;
  recordedAt?: string;
  skills: { name: string; version: string; current?: string; pending?: string; behind: boolean }[];
}

export interface SyncOutcome {
  boxId: string;
  status: 'synced' | 'failed' | 'not-running';
  detail?: string;
}

export type BindingMode = 'include' | 'exclude';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `fetch` an `/api/v1` path and unwrap the envelope's error. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await r.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  if (!r.ok) {
    throw new ApiError(
      body.error?.code ?? String(r.status),
      body.error?.message ?? `request failed (${String(r.status)})`,
    );
  }
  return body as T;
}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const short = (sha: string): string => sha.slice(0, 12);

export function originLabel(o: SkillOrigin | undefined): string {
  if (!o || o.kind === 'upload') return 'upload';
  if (o.kind === 'folder') return `linked folder${o.host ? ` on ${o.host}` : ''}`;
  if (o.kind === 'git')
    return `git ${o.url}${o.path ? `#${o.path}` : ''}${o.ref ? `@${o.ref}` : ''}`;
  return `marketplace ${o.marketplace} · ${o.plugin}`;
}

/** Git and marketplace skills have an upstream a refresh can fetch. */
export const refreshable = (o: SkillOrigin | undefined): boolean =>
  o?.kind === 'git' || o?.kind === 'marketplace';

/** `GET /api/v1/skill-machines`. */
export interface SkillMachine {
  id: string;
  label: string;
  self: boolean;
  online: boolean;
}

export type CompareStatus = 'same' | 'differs' | 'local-only' | 'hub-only' | 'skipped' | 'unknown';

export interface CompareRow {
  name: string;
  description: string;
  status: CompareStatus;
  newer?: 'local' | 'hub';
  agents: string[];
  hub?: { current: string; updatedAt: string; pending: boolean; broken?: string };
  pc?: {
    treeSha: string;
    dirs: string[];
    path: string;
    size: number;
    files: number;
    problems: string[];
    findings: Finding[];
    conflicting?: boolean;
  };
}

/** `GET /api/v1/skill-machines/{id}/compare`. */
export interface SkillCompare {
  machine: SkillMachine;
  error?: string;
  rows: CompareRow[];
  outOfSync: number;
  /** Every skipped name. Absent from a hub older than the skip. */
  skipped?: string[];
}

export type PullResult =
  | { name: string; status: 'imported' | 'unchanged' | 'held'; version: string }
  | { name: string; status: 'failed'; reason: string };

export type SendResult =
  | {
      name: string;
      status: 'installed' | 'replaced' | 'unchanged';
      dir: string;
      links?: string[];
      kept?: string[];
    }
  | { name: string; status: 'skipped' | 'failed'; reason: string };
