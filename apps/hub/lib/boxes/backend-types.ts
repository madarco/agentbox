import type { ProviderKind } from '@agentbox/config';
import type { HubState, ProviderOption } from './types';

// Result of a lifecycle server action.
export type ActionResult = { ok: true } | { ok: false; error: string };

// Result of a box git/service operation that runs a command in the box. On
// success it carries the command's stdout/stderr so the UI can surface git's
// output; on failure `error` is the trimmed stderr (or a resolve error).
export type BoxOpResult = { ok: true; stdout?: string; stderr?: string } | { ok: false; error: string };

// Host apps a box can be opened in (`agentbox open --in <app>`). Mirrors the
// CLI's OPEN_IN_APPS (apps/cli/src/commands/_open-in.ts); duplicated here to keep
// @agentbox/* packages out of the Next bundle, like AGENTS/PROVIDERS in validate.ts.
export type OpenInApp = 'codex' | 'herdr' | 'cmux' | 'vscode' | 'iterm2';

// One app's install/eligibility, as reported by the CLI's `open --targets --json`.
// `providers` (when present) limits the app to boxes on those providers (e.g.
// codex -> ['hetzner']); omitted means any provider.
export interface OpenTargetInfo {
  available: boolean;
  providers?: string[];
}

export type OpenTargetsReport = Record<OpenInApp, OpenTargetInfo>;

// `supported` is false when the hub can't launch host GUI apps at all (a remote
// hub profile, or a non-macOS host) — the UI then shows no Open-in controls.
// `targets` is null in that case, or when the host probe failed.
export interface OpenTargets {
  supported: boolean;
  targets: OpenTargetsReport | null;
}

// One supervised service, normalized from either a live `agentbox-ctl status`
// pull or the persisted box-status snapshot. Fields absent in the persisted
// snapshot (pid/restarts/lastExitCode/command) are filled with nulls/defaults.
export interface ServiceView {
  name: string;
  state: string;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
  blockedOn: string[];
  command: string;
}

export interface TaskView {
  name: string;
  state: string;
}

export interface PortView {
  port: number;
  service: string | null;
}

// A box's agentbox.yaml task/service/port status. `source` says where it came
// from: a live in-box pull, the persisted snapshot (box paused/stopped), or
// unavailable (box gone / never reported).
export interface ServicesResult {
  source: 'live' | 'persisted' | 'unavailable';
  services: ServiceView[];
  tasks: TaskView[];
  ports: PortView[];
  error?: string;
}

// Live git summary for the box detail panel. `box.branch` from getData() goes
// stale after a checkout, so the panel reads this instead.
export interface GitInfo {
  ok: boolean;
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  error?: string;
}

// Input for creating a box in an existing (registered) project. The client
// sends a projectId (never a host path); the backend resolves it to the
// registered project's absolute path server-side. `agent` selects the coding
// agent to start detached in the box; `prompt` is an optional seed turn (empty
// = just start the agent, don't drive it).
export interface CreateBoxInput {
  projectId: string;
  // 'none' = just create the box (like `agentbox create`), don't start an agent.
  agent: 'claude' | 'codex' | 'opencode' | 'none';
  // Sandbox provider to create on. Defaults to 'docker'. The backend rejects a
  // provider that isn't configured (baked) on this host.
  provider?: ProviderKind;
  name?: string;
  prompt?: string;
  // Base ref the box's per-box branch forks from (branch / tag / SHA), instead
  // of the project's current HEAD. Mirrors the CLI's `--from-branch`. The
  // backend validates it against the host repo before enqueuing.
  fromBranch?: string;
  // Seed the agent's first turn with the setup-wizard prompt (generate
  // `agentbox.yaml`). The UI defaults this on for projects that need setup
  // (no `agentbox.yaml` + no default snapshot). Inert for agent === 'none'.
  setupWizard?: boolean;
}

// Branch listing for a project's create-box base-branch picker: the current
// HEAD (the default base) plus local + remote branch names.
export type BranchList =
  | { ok: true; current: string | null; branches: string[] }
  | { ok: false; error: string };

// Create returns immediately with the background job id — the box is built by a
// detached queue worker; progress streams over the per-job log SSE.
export type CreateBoxResult = { ok: true; jobId: string } | { ok: false; error: string };

// One subdirectory in the server-side folder browser. `isProject` flags a folder
// that already looks like a project root (has a .git or agentbox.yaml) so the UI
// can hint which folders are ready to host a box.
export interface DirEntry {
  name: string;
  path: string;
  isProject: boolean;
}

// Listing of one directory on the hub host: the resolved absolute path, its
// parent (null at the filesystem root), and its immediate subdirectories.
export type BrowseDirResult =
  | { ok: true; path: string; parent: string | null; entries: DirEntry[] }
  | { ok: false; error: string };

// Claude re-login sub-state surfaced from the job manifest (see QueueJobLogin).
// worker → UI: phase/url/error; UI → worker: the code (via submitLoginCode).
export interface JobLoginView {
  required: boolean;
  phase: 'starting' | 'awaiting-code' | 'exchanging' | 'done' | 'error';
  url?: string;
  error?: string;
  lastError?: string;
}

// Minimal job view for the log-stream route: the log file to tail, the terminal
// status (so the SSE knows when to stop), the box id once the worker writes it
// back, and (when a re-login is in flight) the login sub-state. Status is a plain
// string to keep this module free of relay imports.
export interface JobView {
  status: string;
  logPath: string;
  boxId?: string;
  login?: JobLoginView;
}

// The host-facing backend. Implemented in lib/hub-backend.ts (Node-only, imports
// the sandbox/relay toolchain) and constructed by the custom server, which sets
// it on `globalThis.__AGENTBOX_HUB_BACKEND`. Next server code (source.ts /
// actions.ts) reaches it ONLY through that global, so the heavy Node/docker
// packages never enter Next's bundle. This is a pure-type module (no runtime
// imports) so both the implementation and the ambient global can share it.
export interface HubBackend {
  // authMode is an env-derived concern layered on by source.ts, not the host
  // backend — so the backend produces everything else.
  getData(): Promise<Omit<HubState, 'authMode'>>;
  // Start a fully-stopped box (resumes when paused, no-op when running). Does
  // not restore agent tmux sessions — that's a CLI-only concern.
  start(id: string): Promise<ActionResult>;
  pause(id: string): Promise<ActionResult>;
  resume(id: string): Promise<ActionResult>;
  stop(id: string): Promise<ActionResult>;
  destroy(id: string): Promise<ActionResult>;
  // Set (or clear, when displayName is empty) a box's cosmetic display label.
  // Pure state — does not touch the container, git branch, or URL.
  rename(id: string, displayName: string): Promise<ActionResult>;
  // Answer a pending host-action approval; resolves the parked in-box RPC.
  answerApproval(id: string, answer: 'y' | 'n'): Promise<ActionResult>;
  // Provider list enriched with base-image freshness (`baseStatus`/
  // `baseStaleReason`). Off the getData() hot path — computing it loads provider
  // code + hashes the runtime build context (memoized with a short TTL). Backs
  // GET /api/v1/providers?freshness=1 so the default endpoint stays fast.
  providersWithFreshness(): Promise<ProviderOption[]>;
  // Enqueue a background create job for a registered project; returns the jobId.
  create(input: CreateBoxInput): Promise<CreateBoxResult>;
  // Persist a provider's credentials (validated against the cloud, then written
  // to ~/.agentbox/secrets.env). `fields` is provider-specific (e.g. { apiKey },
  // { token }, { token, teamId?, projectId? }). Never returns secret values.
  setProviderCredentials(id: string, fields: Record<string, string>): Promise<ActionResult>;
  // Enqueue a background image-bake (prepare) job for a provider; returns the
  // jobId (progress streams over the per-job log SSE, like create). Reuses an
  // in-flight bake for the same provider if one exists.
  prepareProvider(
    id: string,
    opts?: { force?: boolean; claudeInstall?: 'native' | 'npm' },
  ): Promise<CreateBoxResult>;
  // List a project's branches (local + remote) + its current HEAD, for the
  // create-box base-branch picker. Resolves the project by id server-side.
  listBranches(projectId: string): Promise<BranchList>;
  // Register a folder (absolute path) as a project so it can host boxes.
  addProject(absPath: string): Promise<ActionResult>;
  // Unregister a project by id (hash). Refuses if the project still has boxes or
  // in-flight create jobs — only an empty project can be removed.
  removeProject(projectId: string): Promise<ActionResult>;
  // List a directory on the hub host for the folder picker. `dir` defaults to the
  // user's home; entries are the immediate subdirectories.
  browseDir(dir?: string): Promise<BrowseDirResult>;
  // Read a background job (log path + status + login sub-state) for the per-job
  // log SSE. null when the manifest is gone.
  getJob(id: string): Promise<JobView | null>;
  // Deliver a pasted OAuth code to a create job that is awaiting a Claude
  // re-login (writes it onto the manifest for the worker to consume).
  submitLoginCode(id: string, code: string): Promise<ActionResult>;

  // ── box git operations ──
  // Change the box's working branch (git checkout, local to the worktree).
  gitCheckout(id: string, branch: string): Promise<BoxOpResult>;
  // Create a fresh agentbox/* branch from HEAD (or `from`) and switch onto it.
  gitNewBranch(id: string, input: { name: string; from?: string }): Promise<BoxOpResult>;
  // Push the box's branch to the remote via the host relay.
  gitPush(id: string, input?: { remote?: string; force?: boolean }): Promise<BoxOpResult>;
  // Fetch via the relay then merge locally in the box.
  gitPull(id: string, input?: { remote?: string; ffOnly?: boolean }): Promise<BoxOpResult>;
  // Land the box's branch in the host's local repo only (publishes nothing).
  gitPushHost(id: string, input?: { as?: string; force?: boolean }): Promise<BoxOpResult>;
  // Live git summary (current branch + dirty/ahead/behind) for the detail panel.
  getGit(id: string): Promise<GitInfo>;

  // ── box service control ──
  // Live (or persisted) status of the box's agentbox.yaml services/tasks/ports.
  getServices(id: string): Promise<ServicesResult>;
  // Restart one service by name, or every service when name is omitted.
  restartService(id: string, name?: string): Promise<BoxOpResult>;

  // ── host "open in" launchers (localhost hub on macOS only) ──
  // Which host apps are installed + provider-eligible, for the detail-page menu.
  // `supported: false` when the hub can't launch host GUIs (remote/non-macOS).
  openTargets(): Promise<OpenTargets>;
  // Launch the box in a host app by re-shelling the installed `agentbox open
  // <id> --in <app>` (which owns all the SSH-alias / deep-link / terminal-spawn
  // logic). Refuses when openTargets() would report unsupported.
  openIn(id: string, app: OpenInApp): Promise<ActionResult>;
}
