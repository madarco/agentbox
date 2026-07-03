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
  agent: AgentId | string;
  status: BoxStatus;
  createdAt: number;
  lastActivity: number;
  host: string;
  // null when the metric has no host-side source yet (rendered as "—").
  commits: number | null;
  filesTouched: number | null;
  error?: string | null;
}

export interface Project {
  id: string;
  name: string;
  repo: string;
  defaultBranch: string;
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
  reason?: string;
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
}

export const statusMeta: Record<BoxStatus, { label: string; badgeClass: string }> = {
  running: { label: 'running', badgeClass: 'badge-run' },
  paused: { label: 'paused', badgeClass: 'badge-pause' },
  stopped: { label: 'stopped', badgeClass: 'badge-stop' },
  creating: { label: 'creating', badgeClass: 'badge-create' },
  error: { label: 'error', badgeClass: 'badge-err' },
};
