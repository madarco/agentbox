// Box view model — normalized shape the UI renders, produced by
// lib/boxes/source.ts from the host's ~/.agentbox state (state.json + statuses).
import type { AgentId } from '@/components/icons';
import type { AuthMode } from '@/lib/auth-config';

export type BoxStatus = 'running' | 'paused' | 'stopped' | 'creating' | 'error';

export interface Box {
  id: string;
  projectId: string;
  repo: string;
  branch: string;
  task: string;
  // Cosmetic user-set label (via rename), null when unset. `task` already folds
  // this in as the primary label; kept separate so the rename UI can seed its input.
  displayName?: string | null;
  agent: AgentId | string;
  status: BoxStatus;
  createdAt: number;
  lastActivity: number;
  host: string;
  // Sandbox provider (docker | daytona | hetzner | vercel | e2b). Drives which
  // host "open in" targets are offered for this box on the detail page.
  provider: string;
  // null when the metric has no host-side source yet (rendered as "—").
  commits: number | null;
  filesTouched: number | null;
  error?: string | null;
  // Host-openable URLs for the box's web service / VNC desktop. Null when the
  // box has no such endpoint or it isn't reachable (e.g. paused/stopped).
  webUrl?: string | null;
  vncUrl?: string | null;
  // ── Raw host-side fields (host/localhost topology only; the hosted/Postgres
  // source leaves them all undefined). Native clients (the tray app) key off
  // these instead of the UI-normalized fields above. ──
  // Raw provider runtime state. ABSENT on synthetic job boxes — its presence is
  // how a client tells a real box whose agent errored (state 'running', status
  // 'error') from a failed create job (no state). 'destroyed' exists only for
  // assignability from BoxState; the list never emits it.
  state?: 'running' | 'paused' | 'stopped' | 'missing' | 'destroyed';
  name?: string;
  // Absolute host path of the project — host topology only, never hosted.
  projectRoot?: string;
  projectIndex?: number;
  vncEnabled?: boolean;
  gitWorktrees?: Array<{ kind?: string; branch?: string }>;
  claudeSessionTitle?: string;
  codexSessionTitle?: string;
  opencodeSessionTitle?: string;
  claudeActivity?: string;
  codexActivity?: string;
}

export interface Project {
  id: string;
  name: string;
  repo: string;
  defaultBranch: string;
  /**
   * The host repo's currently checked-out branch (`git rev-parse --abbrev-ref HEAD`),
   * i.e. the base a new box would fork from. `null` when detached, unavailable, or on
   * the hosted/Postgres path (no local host repo). Only the localhost hub populates it.
   */
  currentBranch?: string | null;
  /**
   * The host project has no `agentbox.yaml` and no default snapshot, so a new
   * box starts from a bare base. The create modal offers the setup wizard (seed
   * the agent's first turn to generate `agentbox.yaml`) when this is true. Only
   * the localhost hub populates it; undefined on the hosted/Postgres path.
   */
  needsSetup?: boolean;
  provider: string;
  createdAt: number;
}

export interface Repo {
  id: string;
  full: string;
  private: boolean;
  lang: string;
  pushedAt: number;
}

export interface GithubState {
  // false on localhost — the GitHub App is a hosted-hub concern, not a laptop one.
  available: boolean;
  installed: boolean;
  appName: string;
  account: string;
  installedAt: number;
  repos: Repo[];
}

export interface User {
  login: string;
  name: string;
}

// A pending host-action approval, flattened from the relay's in-process prompt
// map. The UI joins `boxId` to a Box (from the same HubState) for display.
export interface Approval {
  id: string;
  boxId: string;
  message: string;
  detail?: string;
  command?: string;
  cwd?: string;
  argv?: string[];
  defaultAnswer: 'y' | 'n';
  createdAt: number;
}

// A provider the box could be created on. `configured` = usable on this host
// (docker always; a cloud provider needs its base baked — see hub-backend). The
// modal disables unconfigured options and shows `reason`.
export interface ProviderOption {
  id: string;
  label: string;
  configured: boolean;
  // Whether the provider has credentials on this host (docker: always true). A
  // cloud provider can have credentials but not yet be `configured` (baked).
  hasCredentials?: boolean;
  // Id of an in-flight bake (prepare) job for this provider, if any — lets the
  // settings UI resume the streamed progress.
  jobId?: string;
  reason?: string;
  // Freshness of an already-baked base image/snapshot vs the current runtime
  // build context. Only populated when the client asks (GET /api/v1/providers
  // ?freshness=1) — computing it loads provider code + hashes the build context,
  // so it stays OFF the default fast path. 'stale' means `agentbox prepare
  // --provider <id>` should be re-run; 'unknown' = couldn't verify (e.g. a dev
  // tree without a built runtime); absent = not requested. Docker reports real
  // freshness too ('unprepared'/'stale' = the next create will bake first) —
  // it stays `configured: true` regardless, since its base self-heals.
  baseStatus?: 'fresh' | 'stale' | 'unprepared' | 'unknown';
  // Human-readable reason when baseStatus === 'stale' (the fingerprint delta).
  baseStaleReason?: string;
}

export interface HubState {
  user: User;
  github: GithubState;
  projects: Project[];
  boxes: Box[];
  approvals: Approval[];
  providers: ProviderOption[];
  // Active gate: 'password' (hetzner/vercel) drives the topbar sign-out; 'token'
  // (localhost) and 'off' show none.
  authMode: AuthMode;
  // The control box this hub operates through (`relay.controlPlaneUrl`), when
  // configured. Present on the PC's localhost hub; null on the control box
  // itself. The topbar links to it so the local hub doesn't pretend to be the
  // brain when a control box holds the shared state.
  controlPlane?: { url: string } | null;
}

export const statusMeta: Record<BoxStatus, { label: string; badgeClass: string }> = {
  running: { label: 'running', badgeClass: 'badge-run' },
  paused: { label: 'paused', badgeClass: 'badge-pause' },
  stopped: { label: 'stopped', badgeClass: 'badge-stop' },
  creating: { label: 'creating', badgeClass: 'badge-create' },
  error: { label: 'error', badgeClass: 'badge-err' },
};
