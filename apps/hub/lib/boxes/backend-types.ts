import type { HubState, ProviderOption } from './types';
import type { AgentId } from '@agentbox/core';

// Result of a lifecycle server action.
export type ActionResult = { ok: true } | { ok: false; error: string };

// Result of a box git/service operation that runs a command in the box. On
// success it carries the command's stdout/stderr so the UI can surface git's
// output; on failure `error` is the trimmed stderr (or a resolve error).
// `exitCode` is the failing box command's own exit code when the failure came
// from a non-zero exec (not a resolve error) — carried so a client can surface a
// faithful exit (e.g. 64 for `git push --host-only` with no host checkout), which
// the /api/v1 code→exit table can't otherwise express.
export type BoxOpResult =
  | { ok: true; stdout?: string; stderr?: string }
  | { ok: false; error: string; exitCode?: number };

// Host apps a box can be opened in (`agentbox open --in <app>`). Mirrors the
// CLI's OPEN_IN_APPS (apps/cli/src/commands/_open-in.ts); duplicated here to keep
// @agentbox/* packages out of the Next bundle, like AGENTS/PROVIDERS in validate.ts.
export type OpenInApp = 'claude' | 'codex' | 'herdr' | 'cmux' | 'vscode' | 'iterm2' | 'finder';

// One app's install/eligibility, as reported by the CLI's `open --targets --json`.
// `providers` (when present) limits the app to boxes on those providers (e.g.
// codex -> ['hetzner']); omitted means any provider.
export interface OpenTargetInfo {
  available: boolean;
  /** Why the app is unavailable (install hint); present only when !available. */
  reason?: string;
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

// A minted, ready-to-open noVNC viewer URL. Cloud signed URLs carry a TTL
// (default 3600s), so this is resolved ON DEMAND and never persisted onto the
// Box payload — which is why its `vncUrl` is null for daytona/vercel/e2b.
export type VncUrlResult = { ok: true; url: string; ttl?: number } | { ok: false; error: string };

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

// Box-shaping knobs the CLI's `agentbox create` resolves before enqueuing, so a
// create routed through the hub builds the SAME box the old inline path did.
// Mirrors @agentbox/relay's QueueJobCreateOpts (kept import-free here, like
// OpenInApp/PROVIDERS, so the heavy packages stay out of the Next bundle). Every
// field is optional; absent → the worker's config default. The web UI sends none
// of these (its create is a plain default box).
export interface CreateBoxOpts {
  image?: string;
  /** Start from this checkpoint (`--snapshot`); else the project's default. */
  snapshot?: string;
  hostSnapshot?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  /** Gitignore-bypassing env/config files to copy in (`--with-env` / wizard picks). */
  envFiles?: string[];
  vnc?: boolean;
  resync?: boolean;
  sharedDockerCache?: boolean;
  portless?: boolean;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  /** Cap commits in the cloud-seed git bundle (0 = full history). */
  bundleDepth?: number;
  /** VM size for cloud providers (hetzner type / daytona cpu-mem-disk / vercel vCPU). */
  size?: string;
  /** Datacenter / region (hetzner / digitalocean). */
  location?: string;
  /** VPS firewall access policy (locked | open | CIDR list). */
  inbound?: string;
  /** `-b`: reuse an existing branch instead of forking agentbox/<name>. */
  useBranch?: string;
  /** `--build`: force a local docker base build instead of pulling. */
  build?: boolean;
  /** `--no-credential-sync` → false. */
  credentialSync?: boolean;
  /** GHCR ref the base is pulled from (docker + daytona). */
  imageRegistry?: string;
  /** `git.pushMode` (`--dangerously-with-credentials` → 'direct'); cloud only. */
  gitPushMode?: 'auto' | 'relay' | 'lease' | 'direct';
  /** SSH destination whose docker engine runs a remote-docker box. */
  remoteHost?: string;
  /** Per-box `--no-dangerously-skip-permissions` opt-out. */
  dangerouslySkipPermissions?: boolean;
  sessionName?: string;
  /**
   * carry: entries the CLI resolved + approved on the host (`ResolvedCarryEntry[]`
   * from @agentbox/core — typed `unknown[]` here to keep that package out of the
   * Next bundle; the backend re-casts). Host-path metadata the worker reads at
   * create time — only meaningful when the worker runs on the same machine as the
   * files (the local file-queue path).
   */
  carry?: unknown[];
}

// Input for creating a box. The client sends EITHER a `projectId` (a registered
// project on the hub's machine — resolved to its absolute path server-side, never
// a client path) OR a `repoUrl` (origin URL the control-plane worker clones when
// there is no local checkout). `agent` selects the coding agent to start detached
// in the box; `prompt` is an optional seed turn (empty = just start the agent).
export interface CreateBoxInput {
  // Exactly one of projectId / repoUrl. projectId → local workspace → file queue;
  // repoUrl (or a projectId with no local folder) → control-plane clone queue.
  projectId?: string;
  repoUrl?: string;
  // 'none' = just create the box (like `agentbox create`), don't start an agent.
  agent: AgentId | 'none';
  // Sandbox provider to create on. Defaults to 'docker'. A bare provider name
  // (ProviderKind) OR a host-qualified `docker:<alias>` / `remote-docker:<alias>`
  // spec targeting a registered remote-docker host. The backend rejects a provider
  // that isn't configured (baked) on this host, or an unknown host alias.
  provider?: string;
  name?: string;
  prompt?: string;
  // Fully-processed agent argv (post-`--`, incl. skip-permissions) for a hub-routed
  // `-i` run. Carried end-to-end so a hub create keeps the same args a local one
  // does — dropping it silently broke flags like --dangerously-skip-permissions.
  agentArgs?: string[];
  // Start the agent in-box even without a seed prompt (the web-UI "create a box"
  // means a box with its agent running). Inert for agent === 'none'.
  startAgent?: boolean;
  // A FOREGROUND create (interactive `agentbox create`) — the file-queue scheduler
  // runs it in its own lane, ungated by queue.maxConcurrent (see QueueJob.foreground).
  foreground?: boolean;
  // Base ref the box's per-box branch forks from (branch / tag / SHA), instead
  // of the project's current HEAD. Mirrors the CLI's `--from-branch`. The
  // backend validates it against the host repo before enqueuing (local path).
  fromBranch?: string;
  // Seed the agent's first turn with the setup-wizard prompt (generate
  // `agentbox.yaml`). The UI defaults this on for projects that need setup
  // (no `agentbox.yaml` + no default snapshot). Inert for agent === 'none'.
  setupWizard?: boolean;
  // Box-shaping knobs the CLI resolved (see CreateBoxOpts). Absent for a web-UI create.
  opts?: CreateBoxOpts;
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
// string to keep this module free of relay imports. `error` carries a failed
// job's reason so the CLI create path can report a failure faithfully rather than
// a silent "done"; `provider`/`name`/`agent`/`createdAt` render the queue listing.
export interface JobView {
  id: string;
  status: string;
  logPath: string;
  boxId?: string;
  login?: JobLoginView;
  error?: string;
  provider?: string;
  name?: string;
  agent?: string;
  createdAt?: string;
}

// One row in the unified job listing (`GET /api/v1/jobs`). Same shape as JobView
// minus the log path (a listing doesn't stream). Covers both the local file queue
// and, on a control box, the control-plane create queue.
export interface JobListItem {
  id: string;
  status: string;
  boxId?: string;
  error?: string;
  provider?: string;
  name?: string;
  agent?: string;
  createdAt?: string;
}

// ── checkpoints (durable project assets) ──

// Result of capturing a box state as a project checkpoint. `kind` is the docker
// manifest type ('layered' / 'merged') or 'snapshot' for a cloud backend.
// `setDefaultKey` is the config key written when --set-default was requested.
export type CheckpointCreateResult =
  | {
      ok: true;
      name: string;
      kind: string;
      ref: string;
      provider: string;
      dir?: string;
      setDefaultKey?: string;
    }
  | { ok: false; error: string };

// One checkpoint row for the listing (docker or a cloud backend). `provider` is
// 'docker' or the backend name; `isDefault` is resolved server-side against the
// project's effective config so the CLI need not re-resolve it.
export interface CheckpointItemView {
  name: string;
  provider: string;
  kind: string;
  sourceBoxName: string;
  createdAt: string;
  isDefault: boolean;
}

// A project's checkpoints, grouped for the `-g` (all-projects) listing. `label`
// is the display name (project basename, or the store segment when the project
// config was GC'd); `projectRoot` is absent for an orphan segment.
export interface CheckpointProjectView {
  segment: string;
  projectRoot?: string;
  label: string;
  items: CheckpointItemView[];
}

export interface CheckpointListing {
  projects: CheckpointProjectView[];
}

// Result of deleting a checkpoint from every store that had it. `removed` lists
// the providers it was deleted from; `clearedKeys` / `warnedKeys` are the default-
// checkpoint config pointers this delete swept (cleared in the project layer, or
// warned when the dangling pointer lives in a layer we can't auto-edit).
export type CheckpointRemoveResult =
  | { ok: true; removed: string[]; clearedKeys: string[]; warnedKeys: string[] }
  | { ok: false; error: string };

// ── prune (fleet cleanup) ──

// Local (docker) prune outcome — mirrors sandbox-docker's PruneResult (duplicated
// to keep @agentbox/* out of the Next bundle, like OPEN_IN_APPS above) plus the
// orphan per-project config dirs the --all tier removes.
export interface PruneResultView {
  removedRecords: string[];
  removedContainers: string[];
  removedVolumes: string[];
  removedSnapshotDirs: string[];
  removedBoxDirs: string[];
  removedCheckpointImages: string[];
  dryRun: boolean;
}

export interface PruneGeneralView {
  kind: 'general';
  result: PruneResultView;
  projectConfigs: string[];
}

// One untracked cloud sandbox the credentials can see but this fleet doesn't track.
export interface CloudOrphanView {
  sandboxId: string;
  name?: string;
  state?: string;
  createdAt?: string;
}

export interface PruneCloudView {
  kind: 'cloud';
  provider: string;
  dryRun: boolean;
  orphans: CloudOrphanView[];
  deleted: number;
  failed: number;
  // Control-box registrations reaped for the deleted sandboxes (0 on a dry run).
  reaped: number;
}

export type PruneView = PruneGeneralView | PruneCloudView | { kind: 'error'; error: string };

// ── agent state ──

// The box's in-box coding-agent status snapshot. Bodies are typed `unknown` here
// so this pure-type module stays free of @agentbox/ctl; the CLI re-casts them.
export interface AgentStateResult {
  // Every reporting agent, keyed by id. THE source — `agent state`/`wait-for`
  // used to be able to read only claude, so those commands were silently
  // meaningless on a codex or opencode box.
  agents: Record<string, unknown>;
  // Claude's body, kept so a client older than this build keeps working.
  // null = no snapshot yet, or claude is not the agent in this box.
  claude: unknown;
}

// ── box service logs ──

// A follow-mode log stream spec: the argv to spawn on the hub and pipe to SSE,
// plus an optional cleanup (e.g. a cloud SSH token teardown). Built from
// provider.buildAttach (cloud) or a docker exec (docker).
export type BoxLogAttachSpec =
  | { ok: true; argv: string[]; env?: Record<string, string>; cleanup?: () => Promise<void> }
  | { ok: false; error: string };

// The host-facing backend. Implemented in lib/hub-backend.ts (Node-only, imports
// the sandbox/relay toolchain) and constructed by the custom server, which sets
// it on `globalThis.__AGENTBOX_HUB_BACKEND`. Next server code (source.ts /
// actions.ts) reaches it ONLY through that global, so the heavy Node/docker
// packages never enter Next's bundle. This is a pure-type module (no runtime
// imports) so both the implementation and the ambient global can share it.
export interface HubBackend {
  // authMode is an env-derived concern layered on by source.ts, not the host
  // backend — so the backend produces everything else. `live` (opt-in, expensive
  // — mirrors providers' `?freshness=1`) refreshes each cloud box's `state` with
  // an SDK probe; omitted/false serves the fast persisted state.
  getData(opts?: { live?: boolean }): Promise<Omit<HubState, 'authMode'>>;
  // Start a fully-stopped box (resumes when paused, no-op when running). This is
  // the box's *compute* lifecycle only; restoring the agent's tmux session is box
  // IO (it reads the box's per-box session pointers and relaunches a detached
  // tmux over exec), which stays on the direct IO plane — the CLI layers it on
  // after this returns, the way it layers its own-machine ssh-config write.
  start(id: string): Promise<ActionResult>;
  pause(id: string): Promise<ActionResult>;
  resume(id: string): Promise<ActionResult>;
  stop(id: string): Promise<ActionResult>;
  // `keepSnapshot` preserves a docker box's local snapshot dir (the CLI's
  // `--keep-snapshot`); default (false) deletes it, matching `agentbox destroy`.
  destroy(id: string, opts?: { keepSnapshot?: boolean }): Promise<ActionResult>;
  // Set (or clear, when displayName is empty) a box's cosmetic display label.
  // Pure state — does not touch the container, git branch, or URL.
  rename(id: string, displayName: string): Promise<ActionResult>;
  // Point the box's in-box browser at its web app so the VNC desktop shows the
  // app instead of a blank X screen (the `agentbox screen` prep step). Called
  // by open-VNC surfaces (hub UI, tray) right before opening the viewer URL.
  // Best-effort on the browser launch; only errors when the box is unusable.
  screen(id: string): Promise<ActionResult>;
  // Mint the host-openable noVNC viewer URL for a box. Docker/hetzner boxes
  // resolve to their stable Portless/OrbStack/loopback URL; cloud boxes to a
  // freshly signed preview URL on 6080, because those expire and so can never
  // ride the Box payload. Read-only: it never starts or resumes the box, so a
  // non-running box is refused rather than silently woken.
  vncUrl(id: string, opts?: { ttl?: number; loopback?: boolean }): Promise<VncUrlResult>;
  // Answer a pending host-action approval; resolves the parked in-box RPC.
  // `cancelled` marks a dismissal distinctly from a plain deny in the audit
  // trail (the `agent approve --cancel` capability); both resolve as not-approved.
  answerApproval(id: string, answer: 'y' | 'n', cancelled?: boolean): Promise<ActionResult>;
  // Provider list enriched with base-image freshness (`baseStatus`/
  // `baseStaleReason`). Off the getData() hot path — computing it loads provider
  // code + hashes the runtime build context (memoized with a short TTL). Backs
  // GET /api/v1/providers?freshness=1 so the default endpoint stays fast.
  // `expandRemoteDockerHosts` (create pickers only) replaces the single
  // remote-docker entry with one `docker:<alias>` option per registered host.
  providersWithFreshness(opts?: { expandRemoteDockerHosts?: boolean }): Promise<ProviderOption[]>;
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
    opts?: {
      force?: boolean;
      /** Each agent's declared settings, keyed by agent id. */
      agentSettings?: Readonly<Record<string, Readonly<Record<string, string | boolean>>>>;
      /** Agents to bake into the base. Omitted/empty = agentless. */
      agents?: string[];
      build?: boolean;
      size?: string;
      location?: string;
      name?: string;
    },
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
  // Read a background job (log path + status + login sub-state + failure reason)
  // for the per-job log SSE and the create-path verdict poll. null when gone.
  getJob(id: string): Promise<JobView | null>;
  // The unified job listing (`agentbox queue list` / `hub jobs`): the local file
  // queue's create jobs plus, on a control box, the control-plane create queue.
  // Newest first.
  listJobs(): Promise<JobListItem[]>;
  // Deliver a pasted OAuth code to a create job that is awaiting a Claude
  // re-login (writes it onto the manifest for the worker to consume).
  submitLoginCode(id: string, code: string): Promise<ActionResult>;

  // ── box git operations ──
  // Change the box's working branch (git checkout, local to the worktree).
  // `args` are extra flags forwarded to `git checkout` (e.g. a pathspec).
  gitCheckout(id: string, branch: string, args?: string[]): Promise<BoxOpResult>;
  // Create a fresh agentbox/* branch from HEAD (or `from`) and switch onto it.
  gitNewBranch(id: string, input: { name: string; from?: string }): Promise<BoxOpResult>;
  // Push the box's branch to the remote via the host relay. `args` are extra
  // flags forwarded to the host-built `git push` (e.g. --tags, --force-with-lease).
  gitPush(
    id: string,
    input?: { remote?: string; force?: boolean; args?: string[] },
  ): Promise<BoxOpResult>;
  // Fetch via the relay then merge locally in the box. `args` forward to the op.
  gitPull(
    id: string,
    input?: { remote?: string; ffOnly?: boolean; args?: string[] },
  ): Promise<BoxOpResult>;
  // Land the box's branch in the host's local repo only (publishes nothing).
  gitPushHost(
    id: string,
    input?: { as?: string; force?: boolean; args?: string[] },
  ): Promise<BoxOpResult>;
  // Live git summary (current branch + dirty/ahead/behind) for the detail panel.
  getGit(id: string): Promise<GitInfo>;

  // ── box service control ──
  // Live (or persisted) status of the box's agentbox.yaml services/tasks/ports.
  getServices(id: string): Promise<ServicesResult>;
  // Restart one service by name, or every service when name is omitted.
  restartService(id: string, name?: string): Promise<BoxOpResult>;

  // ── checkpoints (durable project assets) ──
  // Capture a box's state as a project checkpoint (docker commit / cloud snapshot).
  // Ensures the box is running first; --set-default writes the provider-specific
  // default-checkpoint config key on the hub's machine.
  createCheckpoint(
    id: string,
    opts: { name?: string; merged?: boolean; setDefault?: boolean; replace?: boolean },
  ): Promise<CheckpointCreateResult>;
  // List a project's checkpoints (docker + every cloud backend), or all projects'
  // when `global`. `project` is an absolute project root on the hub's machine.
  listCheckpoints(opts: { project?: string; global?: boolean }): Promise<CheckpointListing>;
  // Delete a checkpoint from every store that has it (or just `provider`'s store),
  // clearing any dangling default-checkpoint config pointer.
  removeCheckpoint(opts: {
    project: string;
    ref: string;
    provider?: string;
  }): Promise<CheckpointRemoveResult>;

  // ── prune (fleet cleanup) ──
  // Without `provider` (or provider === 'docker'): remove orphan docker records/
  // resources (`pruneBoxes`) + orphan project configs. With a cloud provider:
  // enumerate untracked sandboxes, and (when !dryRun) delete them + reap their
  // control-box registrations.
  pruneFleet(opts: { all?: boolean; dryRun?: boolean; provider?: string }): Promise<PruneView>;

  // ── agent state ──
  // The box's in-box coding-agent status snapshot (from the persisted status
  // store). null when the hub doesn't know the box; `{ claude: null }` when it
  // knows the box but no snapshot has been reported yet.
  getAgentState(id: string): Promise<AgentStateResult | null>;

  // ── box service logs ──
  // Non-follow tail of a service log (or the ctl-daemon log with `daemon`).
  boxLogSnapshot(
    id: string,
    opts: { service?: string; tail: number; daemon?: boolean },
  ): Promise<BoxOpResult>;
  // Follow-mode: build the argv to spawn on the hub and stream to SSE. null-box
  // returns { ok:false }. Returned to the route, which owns the spawn + stream.
  boxLogAttach(
    id: string,
    opts: { service?: string; tail: number; daemon?: boolean },
  ): Promise<BoxLogAttachSpec>;

  // ── host "open in" launchers (localhost hub on macOS only) ──
  // Which host apps are installed + provider-eligible, for the detail-page menu.
  // `supported: false` when the hub can't launch host GUIs (remote/non-macOS).
  openTargets(): Promise<OpenTargets>;
  // Launch the box in a host app by re-shelling the installed `agentbox open
  // <id> --in <app>` (which owns all the SSH-alias / deep-link / terminal-spawn
  // logic). Refuses when openTargets() would report unsupported.
  openIn(id: string, app: OpenInApp): Promise<ActionResult>;

  // ── remote-docker host aliases (~/.agentbox/remote-docker-hosts.json) ──
  // List the registered remote-docker host aliases with their baked/default state.
  listRemoteDockerHosts(): Promise<RemoteDockerHostView[]>;
  // Register an alias -> SSH connection: validates + probes the host (ssh + docker)
  // before saving. Does NOT bake the image (would block for minutes). `default`
  // also pins it as box.remoteDockerHost (global).
  //
  // `connection` + `identity` arrive when another machine SHARES one of its
  // engines with this hub: the ssh string may be an alias only that machine can
  // resolve, so the sender includes the `ssh -G` expansion and a private key
  // minted for us. The key is written to this hub's own key dir (0600) and the
  // probe runs with it, so success means WE can reach the engine.
  addRemoteDockerHost(
    alias: string,
    ssh: string,
    opts?: {
      default?: boolean;
      connection?: { host: string; user?: string; port?: number };
      identity?: string;
    },
  ): Promise<ActionResult>;
  // Forget an alias: drops it from the registry + baked-image record, clears the
  // global default if it pointed here. Returns the box names created against the
  // alias (now unreachable) so the caller can warn. Local record only.
  removeRemoteDockerHost(
    alias: string,
  ): Promise<{ ok: true; boxesAffected: string[] } | { ok: false; error: string }>;
  // Enqueue a background bake of the box image on one host (async; returns the
  // jobId — progress streams over GET /jobs/{id}/logs, like prepareProvider).
  // Reuses an in-flight bake for the same host if one exists.
  bakeRemoteDockerHost(alias: string): Promise<CreateBoxResult>;
}

// One remote-docker host alias, as surfaced by the hub API.
export interface RemoteDockerHostView {
  alias: string;
  /** The SSH connection string the alias resolves to. */
  ssh: string;
  /** Whether the box image is baked on this host (from the prepared-state record). */
  baked: boolean;
  bakedImageRef?: string;
  /** Whether this alias is the configured default (box.remoteDockerHost). */
  default: boolean;
  /**
   * True when this hub holds its own key for the host — i.e. the entry was
   * shared with it rather than registered from its own `~/.ssh/config`.
   */
  managedKey?: boolean;
}
