import type {
  HubState,
  ManagerView,
  ProviderOption,
  ProviderSizeCheck,
  WorkspaceView,
} from './types';
import type { AgentId } from '@agentbox/core';
import type {
  AddWorkspaceInput,
  BoxTaskSummary,
  HostSession,
  ManagerBoxTarget,
  ManagerHeartbeat,
  ManagerRegistration,
  ManagerStatus,
  TimelineEvent,
  TimelineEventInput,
  TimelineEventType,
  TimelineNoteKind,
  TimelinePr,
  TimelineStamp,
  WorkspaceProjectInput,
  WorkTask,
  WorkTaskExternalRef,
  WorkTaskStatus,
} from '@agentbox/relay';

// Result of a lifecycle server action.
export type ActionResult = { ok: true } | { ok: false; error: string };

// Result of registering or creating a project: the registry id (hash of the
// canonical root) and that root, so a client can select the project without a
// second `GET /projects`.
export type ProjectResult = { ok: true; id: string; path: string } | { ok: false; error: string };

// `POST /projects` create shape: make `<parent>/<name>` and register it.
export interface CreateProjectInput {
  parent: string;
  name: string;
  // `git init` + a `.gitignore` (`.agentbox/`) + an initial commit on `main`, so
  // an in-container worktree has a HEAD to branch from. Off = an empty folder.
  git: boolean;
}

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
  /**
   * Whether the service declares a `ready_when` probe. A probed service enters
   * `running` when its process spawns and only reaches `ready` once the probe
   * passes, so a caller waiting for it to be UP must not accept `running` here.
   *
   * Optional because a box whose ctl predates the field sends neither half;
   * absent means "treat as unprobed", matching `BoxStatusServiceEntry.probed`.
   */
  probed?: boolean;
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

/**
 * A service agent's web URL, plus the sign-in link when its UI takes an auth
 * token from the URL fragment.
 *
 * `signInUrl` is null for a box whose agent declares no such field, and for one
 * whose daemon has not written its token yet — the caller opens `url` and the
 * user is asked for the token, which is exactly the old behaviour.
 *
 * `signInPending` separates those two: TRUE means this box hosts a daemon that
 * DOES have a token and could not give one — it is still starting, or still
 * onboarding — so `url` right now opens its sign-in prompt at best and a dead
 * port at worst. A client that opens the link anyway shows the user a broken
 * page and no reason for it; one that reads this can say "not ready yet" and
 * offer to wait. FALSE means the plain `url` is the right and complete answer.
 */
export type BoxWebUrlResult =
  | { ok: true; url: string; signInUrl: string | null; signInPending: boolean }
  | { ok: false; error: string };

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
  /** `--persistent` / `--no-persistent`: always-on box (config `box.persistent`). */
  persistent?: boolean;
  /** Other agents' host logins to seed as model auth (`--model-auth`; service agents). */
  borrowCredentials?: string[];
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
  /**
   * Approve the project's `carry:` block without asking — the API equivalent of
   * the CLI's `--carry-yes`. `clone` sets it: it has no human to ask, and it
   * inherits the grant the source box already holds for this project.
   */
  carryYes?: boolean;
  /**
   * Decline the project's `carry:` block without asking — the API equivalent of
   * the CLI's `--carry skip` / `AGENTBOX_CARRY=skip`. A CLI create runs the gate
   * on the host and posts its ANSWER here; without this the hub would re-ask a
   * `required` prompt with nobody to answer it and refuse the create.
   */
  carrySkip?: boolean;
  /**
   * Re-open a carry approval this project already gave — the API equivalent of
   * `--carry ask`. A standing approval is otherwise invisible to a GUI client,
   * which would leave no way to review or withdraw permission to copy host
   * secrets from the web UI or the tray.
   */
  carryAsk?: boolean;
  /**
   * Answers to the questions GET/POST create-preflight returned
   * (`PromptAnswer[]` from @agentbox/core — typed `unknown[]` here to keep that
   * package out of the Next bundle). A create that omits an answer to a
   * `required` prompt is refused rather than silently defaulted.
   */
  promptAnswers?: unknown[];
  /**
   * Put a backed-up bot's IDENTITY back after the box is up — set only by
   * `POST /projects/:id/restore`, never by a plain create.
   *
   * The workspace half needs nothing here: the staged tree IS the new box's
   * project, so it rides the ordinary create. The state half cannot, because it
   * belongs inside the agent's own config dir and the daemon must already own
   * that dir — so the worker waits for the service to come up ON ITS OWN, stops
   * it, pushes `<bundleDir>/state` in, and restarts. That ordering is forced by
   * openclaw's `run_once: marker` onboard task, whose marker lives on the box
   * ROOTFS and therefore fires on every fresh box whatever the volume holds:
   * letting it run and then replacing what it wrote is the only sequence that
   * survives later boots.
   */
  restore?: {
    /** Absolute bundle dir on the HUB's machine (`…/bots/<bot>/<stamp>`). */
    bundleDir: string;
    /** The agent whose state dir the bundle carries. */
    agent: string;
  };
}

// What a create would ask the user, before anything is provisioned. `prompts`
// is a `PromptRequest[]` (typed `unknown[]` to keep @agentbox/core out of the
// Next bundle); `unavailable` names each gate this hub cannot run and why — a
// remote control box cannot read the caller's files, and saying so is better
// than silently dropping them.
export interface CreatePreflightResult {
  prompts: unknown[];
  unavailable: { topic: string; reason: string }[];
}

export interface CreatePreflightInput {
  projectId: string;
  agent: string;
  provider?: string;
  /**
   * Re-open a carry approval this project already gave, so the table is shown
   * again — the API equivalent of `--carry ask`, and the only way a GUI client
   * can review or withdraw a standing permission to copy host files.
   */
  carryAsk?: boolean;
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
  // The manager session the create came from; the job is attached to it so the
  // box groups under that manager. Absent for a web-UI / tray create.
  managerId?: string;
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
export interface HubBackend extends WorkspaceBackend, ManagerBackend, TimelineBackend {
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
  start(id: string, meta?: TimelineMeta): Promise<ActionResult>;
  pause(id: string, meta?: TimelineMeta): Promise<ActionResult>;
  resume(id: string, meta?: TimelineMeta): Promise<ActionResult>;
  stop(id: string, meta?: TimelineMeta): Promise<ActionResult>;
  // `keepSnapshot` preserves a docker box's local snapshot dir (the CLI's
  // `--keep-snapshot`); default (false) deletes it, matching `agentbox destroy`.
  destroy(
    id: string,
    opts?: { keepSnapshot?: boolean },
    meta?: TimelineMeta,
  ): Promise<ActionResult>;
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
  // The box's web URL and, for a service agent whose UI reads a token from the
  // URL fragment (openclaw's Control UI), a link that opens it already signed
  // in. Minted at CLICK TIME like `vncUrl`, and for the same two reasons: the
  // token is an exec into the box, and it is a live credential that has no
  // business on every poll of every box.
  webUrl(id: string): Promise<BoxWebUrlResult>;
  // Answer a pending host-action approval; resolves the parked in-box RPC.
  // `cancelled` marks a dismissal distinctly from a plain deny in the audit
  // trail (the `agent approve --cancel` capability); both resolve as not-approved.
  // `openedByClient` is for `open-link` only: the caller already opened the URL
  // on its own machine, so the host must not open it again. Answering is also
  // the CLAIM — `ok: false` means another surface got there first.
  answerApproval(
    id: string,
    answer: 'y' | 'n',
    cancelled?: boolean,
    openedByClient?: boolean,
  ): Promise<ActionResult>;
  // Provider list enriched with base-image freshness (`baseStatus`/
  // `baseStaleReason`). Off the getData() hot path — computing it loads provider
  // code + hashes the runtime build context (memoized with a short TTL). Backs
  // GET /api/v1/providers?freshness=1 so the default endpoint stays fast.
  // `expandRemoteDockerHosts` (create pickers only) replaces the single
  // remote-docker entry with one `docker:<alias>` option per registered host.
  providersWithFreshness(opts?: { expandRemoteDockerHosts?: boolean }): Promise<ProviderOption[]>;
  // Enqueue a background create job for a registered project; returns the jobId.
  create(input: CreateBoxInput, meta?: TimelineMeta): Promise<CreateBoxResult>;
  // What would a create for this project + agent ask the user? Runs the real
  // gates with a collecting asker, so the questions returned here are by
  // construction the questions `create` asks.
  createPreflight(input: CreatePreflightInput): Promise<CreatePreflightResult>;
  // Persist a provider's credentials (validated against the cloud, then written
  // to ~/.agentbox/secrets.env). `fields` is provider-specific (e.g. { apiKey },
  // { token }, { token, teamId?, projectId? }). Never returns secret values.
  setProviderCredentials(id: string, fields: Record<string, string>): Promise<ActionResult>;
  // Would creating a box at `size` on this provider actually get that size?
  // Most backends honour a size per create and answer `false`. Daytona and e2b
  // fix resources when the base is baked and discard anything else, so they
  // answer `true` with the sentence to show the user — which is what lets a
  // create form re-bake only when it has to, instead of on every size change.
  // A provider with no `sizeIgnoredReason` hook answers `false`.
  checkProviderSize(id: string, size: string): Promise<ProviderSizeCheck>;
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
  addProject(absPath: string): Promise<ProjectResult>;
  // Create `<parent>/<name>` (empty, or a fresh git repo) and register it.
  // Refuses an existing target and a parent that sits inside another project.
  createProject(input: CreateProjectInput): Promise<ProjectResult>;
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
  gitCheckout(
    id: string,
    branch: string,
    args?: string[],
    meta?: TimelineMeta,
  ): Promise<BoxOpResult>;
  // Create a fresh agentbox/* branch from HEAD (or `from`) and switch onto it.
  gitNewBranch(
    id: string,
    input: { name: string; from?: string },
    meta?: TimelineMeta,
  ): Promise<BoxOpResult>;
  // Push the box's branch to the remote via the host relay. `args` are extra
  // flags forwarded to the host-built `git push` (e.g. --tags, --force-with-lease).
  gitPush(
    id: string,
    input?: { remote?: string; force?: boolean; args?: string[] },
    meta?: TimelineMeta,
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
    meta?: TimelineMeta,
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

  // ── workspace sync / clone (host <-> live box) ──

  // Push the host workspace into a live box (`agentbox sync`). Merges through
  // git when the workspace is a repo, else overlays the plain files; the BOX
  // wins every conflict either way, and the skipped host paths come back so the
  // caller can surface them.
  uploadBox(id: string, opts?: UploadBoxInput): Promise<UploadBoxResult>;
  // Stage a clone: export the source box's workspace files into a fresh host
  // dir and register it as a project. Returns what `create` needs to build the
  // new box; the agent's config volume and credential are deliberately NOT
  // copied, so the clone onboards with its own identity.
  prepareClone(id: string, input?: CloneBoxInput): Promise<PrepareCloneResult>;

  // ── bot backups (a service bot's workspace + its identity) ──

  // Capture a box into `<project>/.agentbox/bots/<bot>/<stamp>/`: the workspace
  // half, plus — when the box's agent declares a state backup — its whole state
  // dir, IDENTITY INCLUDED (gateway token, pairings, history). The state half is
  // best-effort: a box whose agent cannot be reached still yields a usable
  // workspace bundle, and the manifest records `state: false` so a later restore
  // knows what it holds rather than discovering it halfway through.
  backupBox(id: string, input?: BackupBoxInput): Promise<BackupBoxResult>;
  // Every bot a project holds a backup of, each with its stamps newest first and
  // its manifest folded in — the restore picker's source. Read-only.
  listBots(projectId: string): Promise<BotsResult>;
  // Stage a restore: resolve the bundle, refuse when it would produce two live
  // gateways on one identity, and copy the workspace half into the live dir the
  // new box will run on. Returns what `create` needs; the STATE half rides
  // `CreateBoxOpts.restore` and is applied by the worker once the box is up.
  prepareRestore(projectId: string, input: RestoreProjectInput): Promise<PrepareRestoreResult>;
}

export type BotsResult =
  | {
      ok: true;
      bots: Array<{
        bot: string;
        /** The stamp `latest` resolves to, when the link is there and intact. */
        latest?: string;
        backups: Array<{
          stamp: string;
          agent?: string;
          /**
           * False when the bundle carries only a workspace. A picker must show
           * this: restoring one gives a working box with a FRESH identity, which
           * is not what "restore this bot" promises.
           */
          state: boolean;
          boxName?: string;
          provider?: string;
        }>;
      }>;
    }
  | { ok: false; error: string };

// Options for POST /projects/:id/restore.
export interface RestoreProjectInput {
  /** Which bot to bring back. Required. */
  bot: string;
  /** Which backup (default: whatever `latest` points at). */
  stamp?: string;
  /** Name for the new box (default: the bot name). */
  name?: string;
  /** Provider for the new box (default: the one the bundle was captured on). */
  provider?: string;
  /**
   * Dir for the restored workspace ON THE HUB'S MACHINE (default
   * `<project>/.agentbox/bots/<bot>/workspace`). MUST be absolute, for the same
   * reason clone's `into` must be: this process's cwd is wherever the hub daemon
   * was started, so a relative path has no defensible meaning.
   */
  into?: string;
  /**
   * Proceed even when the source box is still running, or the destination dir is
   * not empty. Both defaults refuse — the first because two live gateways cannot
   * share one identity, the second because a non-empty destination is usually an
   * earlier restore still in use.
   */
  force?: boolean;
  persistent?: boolean;
}

export type PrepareRestoreResult =
  | {
      ok: true;
      /** Registered project id for the staged dir — feed straight to create. */
      projectId: string;
      /** Absolute host dir the bundle's workspace was staged into. */
      workspace: string;
      /** Absolute bundle dir, so the worker can find the state half. */
      bundleDir: string;
      name: string;
      provider: string;
      bot: string;
      stamp: string;
      /** Files staged from the bundle's workspace half. */
      files: number;
      /** The agent whose identity this restores. */
      agent: string;
      persistent?: boolean;
    }
  | { ok: false; error: string };

// Options for POST /boxes/:id/backup.
export interface BackupBoxInput {
  /** Bot name the bundle is filed under (default: the box name). */
  name?: string;
  /** Backups to keep for this bot; older ones are pruned (default 3). */
  keep?: number;
  /** Whose state to capture (default: the box's own recorded agent). */
  agent?: string;
  includeNodeModules?: boolean;
}

export type BackupBoxResult =
  | {
      ok: true;
      bot: string;
      stamp: string;
      /** Absolute host dir of the bundle, on the HUB's machine. */
      dir: string;
      /** The agent whose state was targeted; absent when the box has none. */
      agent?: string;
      /** False when only the workspace was captured — no identity in this bundle. */
      state: boolean;
      /** Relative paths taken through SQLite's online-backup API. */
      databases?: string[];
      /** Workspace files exported. */
      files: number;
      /** Older bundles removed to honour `keep`. */
      pruned: string[];
      /** The hub wrote `.agentbox/` into the project's .gitignore. */
      wroteGitignore: boolean;
    }
  | { ok: false; error: string };

// Options for POST /boxes/:id/sync.
export interface UploadBoxInput {
  /** Push node_modules too (non-git workspaces only). */
  includeNodeModules?: boolean;
}

export type UploadBoxResult =
  | {
      ok: true;
      /** Which leg ran: a git merge+overlay, or a plain file overlay. */
      mode: 'git' | 'files';
      /** Files copied into the box (always 0 on the git leg). */
      copied: number;
      /** Host paths skipped to keep the box's version. */
      conflicts: string[];
    }
  | { ok: false; error: string };

// Options for POST /boxes/:id/clone.
export interface CloneBoxInput {
  /** Name for the new box (default `<source>-clone`). */
  name?: string;
  /** Provider for the new box (default: the source box's). */
  provider?: string;
  /**
   * Dir for the clone's workspace ON THE HUB'S MACHINE (default
   * `~/.agentbox/clones/<name>`, in the hub user's home). MUST be absolute: this
   * process's cwd is wherever the hub daemon was started, so a relative path has
   * no defensible meaning. `parseCloneBox` enforces it at the API boundary.
   */
  into?: string;
  includeNodeModules?: boolean;
  /**
   * `--persistent` / `--no-persistent` on the clone. Absent inherits the SOURCE
   * box's persistence — cloning an always-on service box gives an always-on
   * clone, and cloning an expendable box does not.
   */
  persistent?: boolean;
}

export type PrepareCloneResult =
  | {
      ok: true;
      /** Registered project id for the exported dir — feed straight to create. */
      projectId: string;
      /** Absolute host dir the workspace was exported to. */
      workspace: string;
      name: string;
      provider: string;
      /** Files exported. */
      files: number;
      /**
       * The agent the clone should run — set only when the source box runs a
       * SERVICE agent, whose identity IS the box. Absent means the historical
       * agentless clone.
       */
      agent?: string;
      /**
       * Resolved always-on flag for the create, or undefined to leave it to the
       * hub's config layers. Explicit input wins; else the source box's.
       */
      persistent?: boolean;
      /** The source box's borrowed model logins, so the clone borrows the same. */
      borrowedCredentials?: string[];
    }
  | { ok: false; error: string };

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

// ── workspaces / tasks / manager ──

/**
 * A host agent session as the CLI names it (`X-AgentBox-Session`), plus the turn
 * that caller read from its own transcript (`X-AgentBox-Session-Turn`).
 *
 * The turn is client-asserted and only usable for a manager whose transcript is
 * NOT on this hub: where the hub can read it, it does, and ignores this.
 */
export interface TimelineSessionRef {
  agent: string;
  sessionId: string;
  turn?: number;
  prompt?: string;
}

/** Who made a mutation (for the timeline), and the note explaining it, if any. */
export interface TimelineMeta {
  stamp?: TimelineStamp;
  /**
   * The caller's `X-AgentBox-Session`, not yet resolved: set instead of `stamp`
   * when the route does not know the workspace, which the backend resolves it in.
   */
  session?: TimelineSessionRef;
  note?: string;
}

/**
 * Where a row sits when the timeline is drawn as a branch graph. Added at read
 * time over the whole log, so a lane keeps its id and fork on every page.
 */
export interface TimelineLane {
  /** `trunk`, `box:<boxId>`, or `branch:<head>` for a pull request no box is known to own. */
  id: string;
  kind: 'trunk' | 'box' | 'branch';
  /** On the lane's oldest row: the lane it forked from. */
  from?: string;
  /** `pr.merged`: the lane it merged into. The row itself stays on its own lane. */
  into?: string;
  /** The lane's branch, on its first row and on every row where it changes. */
  branch?: string;
  /** On the lane's newest item and on its live rows: the lane goes on past that row. */
  open?: boolean;
}

/** A timeline row: an event, or a `plan` that several `task.created` events collapsed into. */
export interface TimelineItem extends Omit<TimelineEvent, 'type'> {
  type: TimelineEventType | 'plan';
  /** `plan`: how many tasks it created. */
  count?: number;
  /** `pr.merged`: a message about this PR was sent to the manager before it merged. */
  approvedByYou?: boolean;
  /** The branch on the web (`…/tree/<branch>`); added at read time, only when its GitHub repo is known. */
  branchUrl?: string;
  lane?: TimelineLane;
}

/** A row that is true now, built at read time and never stored. */
export interface TimelineLiveItem {
  id: string;
  type: 'task.in_progress' | 'pr.ready';
  at: string;
  boxId?: string;
  boxName?: string;
  agent?: string;
  branch?: string;
  /** As on {@link TimelineItem}. */
  branchUrl?: string;
  managerId?: string;
  task?: { id: string; title: string };
  taskIds?: string[];
  /** `task.in_progress` on a running box: its uncommitted diff. */
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  pr?: TimelinePr;
  /** `pr.ready`: waiting for someone to approve the merge. */
  awaiting?: boolean;
  /** `pr.ready`: a message about it was already sent to the manager. */
  approved?: boolean;
  /** As on {@link TimelineItem}; always `open`. */
  lane?: TimelineLane;
}

export interface TimelineSummary {
  since: string;
  merged: number;
  additions: number;
  deletions: number;
  tasksDone: number;
  /** Ready PRs nobody approved yet, plus pending approvals on the workspace's boxes. */
  awaiting: number;
}

export interface TimelineResponse {
  items: TimelineItem[];
  live: TimelineLiveItem[];
  summary?: TimelineSummary;
  github: 'ok' | 'syncing' | 'unavailable';
}

export interface TimelineQuery {
  before?: string;
  since?: string;
  limit?: number;
  /** `false`: report the GitHub sync's last status without starting one (a frequent, cheap read). */
  sync?: boolean;
  /**
   * Only one manager session's rows: the ones it stamped, and the ones on a box it owns.
   * An id no manager in the workspace has yields an empty timeline, not an error.
   */
  managerId?: string;
}

export type ManagerNoteResult = { ok: true; event: TimelineEvent } | { ok: false; error: string };

/** How a message reached the manager: its hub tmux session, its terminal's pane, or a resume. */
export type ManagerMessageDelivery = 'session' | 'pane' | 'resumed';

export type ManagerMessageResult =
  | {
      ok: true;
      delivered: ManagerMessageDelivery;
      manager: ManagerView;
      event: TimelineEvent | null;
    }
  | {
      ok: false;
      error: string;
      code?: 'manager_unreachable';
      /** The machine the manager runs on: where the client retries. */
      details?: { host: string };
    };

/**
 * A manager op refused because this hub is not the machine the manager runs on.
 * `details.host` is where it does run — its own hostname, for a client whose
 * local hub holds the process while a control box holds the record.
 */
export interface ManagerWrongHost {
  ok: false;
  error: string;
  code: 'wrong_host';
  details: { host: string };
}

/** The timeline domain slice (`lib/backend/timeline.ts`). */
/**
 * The result of appending one forwarded event: the event when it landed, nothing
 * when its `key` was already in the log (a retried report lands once).
 */
export type TimelineRecordResult =
  | { ok: true; event?: TimelineEvent }
  | { ok: false; error: string };

export interface TimelineBackend {
  /** `null` = unknown workspace. */
  getTimeline(wsId: string, q?: TimelineQuery): Promise<TimelineResponse | null>;
  /**
   * Append one event a hub that does NOT hold the store produced (a PC's docker
   * box, its queue worker). `null` = unknown workspace. The caller is
   * authenticated by the same `/api/v1` Bearer as every other route.
   */
  recordTimelineEvent(
    wsId: string,
    input: TimelineEventInput,
  ): Promise<TimelineRecordResult | null>;
}

export type WorkspaceResult = { ok: true; workspace: WorkspaceView } | { ok: false; error: string };
/** `invalid`: the request itself is wrong (400), not the resource's state (409). */
export type TaskResult =
  | { ok: true; task: WorkTask }
  | { ok: false; error: string; invalid?: true };
export type TasksResult = { ok: true; tasks: WorkTask[] } | { ok: false; error: string };
export type ManagerResult =
  | {
      ok: true;
      manager: ManagerView;
      /** Said with a stop that left the agent's session running (Claude's background daemon). */
      notice?: string;
    }
  | { ok: false; error: string }
  | ManagerWrongHost;
export type DetectManagerResult =
  | { ok: true; manager: ManagerView; workspace: WorkspaceView; created: boolean }
  | { ok: false; error: string; invalid?: true };

/** What `listResumableHostSessions` answers: the picker's rows, plus whether this agent has any. */
export interface ManagerSessionsResult {
  agent: string;
  /** False when this agent's on-disk session format is not one we can resume. */
  supported: boolean;
  sessions: HostSession[];
}

/**
 * The sessions listing, or a refusal — an agent's sessions are files in the
 * folder, so only the machine that has the folder can list them.
 */
export type ManagerSessionsAnswer =
  | { ok: true; sessions: ManagerSessionsResult }
  | { ok: false; error: string }
  | ManagerWrongHost;

export interface TaskFilter {
  projectId?: string;
  boxId?: string;
  status?: WorkTaskStatus;
  managerId?: string;
}

export interface AddTaskInput {
  title: string;
  description?: string;
  projectId?: string;
  dependsOn?: string[];
  createdBy?: WorkTask['createdBy'];
  externalRef?: WorkTaskExternalRef;
  boxId?: string;
  boxJobId?: string;
  managerId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: WorkTaskStatus;
  /** `null` clears the project scope; `undefined` leaves it as it was. */
  projectId?: string | null;
  dependsOn?: string[];
  externalRef?: WorkTaskExternalRef;
  /** `null` clears the manager; `undefined` leaves it as it was. */
  managerId?: string | null;
}

/** A box that exists, or the create job that will become one. */
export type AssignTarget = { boxId: string } | { boxJobId: string };

export interface StartManagerInput {
  /** An agent the hub's registry knows. There is no free-form command: the
   *  manager runs on the HUB'S machine, not inside a box. */
  agent: string;
  /** Resume this session. One an existing manager already holds resumes THAT manager. */
  sessionId?: string;
  /** With a `sessionId` whose hub-run manager is running: restart it instead of refusing. */
  restart?: boolean;
}

/** What the CLI sends from inside a host agent session. */
export interface DetectManagerInput {
  agent: string;
  sessionId: string;
  /** Absolute folder the session runs in, on the caller's machine. */
  cwd: string;
  pid?: number;
  host?: string;
  /** `$AGENTBOX_MANAGER`: set inside a hub-run manager's own session. */
  managerId?: string;
  /** `$TMUX_PANE` of the session's terminal, so a message can be typed into it. */
  tmuxPane?: string;
  /**
   * The AgentBox tmux session (`agentbox-manager-*`) the caller runs in. The hub
   * checks it exists here and starts in `cwd`, then records the manager as run
   * from it.
   */
  tmuxSession?: string;
  /** A box (or create job) this session just made, attached in the same call. */
  boxId?: string;
  boxJobId?: string;
  /**
   * The caller's scan of `cwd`, used only when no workspace contains it and one
   * is created here. The folders are on the caller's machine, so the hub cannot
   * scan them itself.
   */
  projects?: WorkspaceProjectInput[];
  /** The caller's `$HOME`: the folder rules refuse a workspace at (or above) it. */
  home?: string;
}

export interface ManagerFilter {
  workspaceId?: string;
  status?: ManagerStatus;
}

/**
 * The manager domain slice (`lib/backend/managers.ts`): host agent sessions
 * that orchestrate boxes, many per workspace.
 */
export interface ManagerBackend {
  /** Register (or refresh) the session a CLI call came from, creating its workspace if none contains it. */
  detectManager(input: DetectManagerInput): Promise<DetectManagerResult>;
  listManagers(filter?: ManagerFilter): Promise<ManagerView[]>;
  getManager(id: string): Promise<ManagerView | null>;
  /** `null` = unknown workspace. */
  listWorkspaceManagers(wsId: string): Promise<ManagerView[] | null>;
  startManager(wsId: string, input: StartManagerInput, meta?: TimelineMeta): Promise<ManagerResult>;
  /**
   * Record a manager session another machine opened in tmux (its hub started the
   * process; this hub owns the workspace). One of the only two manager writes a
   * control box takes from another host — the other is `reportManager`.
   */
  registerManager(
    wsId: string,
    input: ManagerRegistration,
    meta?: TimelineMeta,
  ): Promise<ManagerResult>;
  /** Store what the machine a manager runs on reports about it. */
  reportManager(id: string, beat: ManagerHeartbeat): Promise<ManagerResult>;
  resumeManager(id: string, meta?: TimelineMeta): Promise<ManagerResult>;
  stopManager(id: string, meta?: TimelineMeta): Promise<ManagerResult>;
  /**
   * Open a claude manager's detached Claude background session in a hub tmux
   * session (`claude attach`). The record's kind and session are unchanged.
   */
  attachManager(id: string): Promise<ManagerResult>;
  /**
   * The timeline stamp for a session (the CLI's `X-AgentBox-Session`) or a
   * manager id: its manager, turn and that turn's prompt. With `wsId`, only a
   * manager of that workspace. Never writes.
   */
  timelineStamp(
    ref: TimelineSessionRef | { managerId: string },
    wsId?: string,
  ): Promise<TimelineStamp | undefined>;
  /** Record a manager note, stamped with the manager's current turn. */
  addManagerNote(
    id: string,
    input: { text: string; kind?: TimelineNoteKind },
  ): Promise<ManagerNoteResult>;
  /** Type a message into the manager's session (resuming a stopped one with it). */
  sendManagerMessage(
    id: string,
    input: { text: string; prNumber?: number; repo?: string },
    meta?: TimelineMeta,
  ): Promise<ManagerMessageResult>;
  /** Forget a manager record. Refused while it runs, unless `force`. */
  removeManager(id: string, opts?: { force?: boolean }): Promise<ActionResult>;
  /**
   * Report every manager THIS machine runs to the hub that holds its record, so
   * a control box can show a live status for a session it cannot probe. A no-op
   * (0) when the records are on this disk. Driven by the hub daemon's heartbeat
   * loop and after every manager mutation.
   */
  reportManagers(): Promise<number>;
  listManagerSessions(wsId: string, agent?: string): Promise<ManagerSessionsAnswer | null>;
  /**
   * Record that a manager's create produced this box, or the job building one.
   * Best-effort from `create()`, and from the `attach-box` route the hub that
   * built the box posts when the record lives on another hub.
   */
  attachManagerBox(managerId: string, target: ManagerBoxTarget): Promise<ActionResult>;
  /** boxId | create-job id -> managerId, for `Box.managerId` in getData(). */
  managerByBox(): Promise<Map<string, string>>;
}

/**
 * The workspace domain slice (`lib/backend/workspaces.ts`). Split out of the
 * monolithic backend so new domains land in their own file; `HubBackend`
 * extends it, so callers still see one object.
 */
export interface WorkspaceBackend {
  listWorkspaces(): Promise<WorkspaceView[]>;
  getWorkspace(id: string): Promise<WorkspaceView | null>;
  /**
   * Register (or refresh) a workspace from a scan the CLIENT ran: the folders
   * are on `input.host`, which need not be this hub's machine. Idempotent.
   */
  addWorkspace(input: AddWorkspaceInput): Promise<WorkspaceResult>;
  renameWorkspace(id: string, name: string): Promise<WorkspaceResult>;
  /** Unregister. The folder, its projects and their boxes are untouched. Refused while a manager runs, unless `force`. */
  removeWorkspace(id: string, opts?: { force?: boolean }): Promise<ActionResult>;

  /** `null` = unknown workspace (so a route can answer 404 rather than an empty list). */
  listTasks(wsId: string, filter?: TaskFilter): Promise<WorkTask[] | null>;
  listAllTasks(filter?: TaskFilter & { workspaceId?: string }): Promise<WorkTask[]>;
  getTask(wsId: string, taskId: string): Promise<WorkTask | null>;
  addTask(wsId: string, input: AddTaskInput, meta?: TimelineMeta): Promise<TaskResult>;
  updateTask(
    wsId: string,
    taskId: string,
    patch: UpdateTaskInput,
    meta?: TimelineMeta,
  ): Promise<TaskResult>;
  completeTask(wsId: string, taskId: string, meta?: TimelineMeta): Promise<TaskResult>;
  removeTask(wsId: string, taskId: string, meta?: TimelineMeta): Promise<ActionResult>;
  assignTasks(
    wsId: string,
    ids: string[],
    target: AssignTarget,
    meta?: TimelineMeta,
  ): Promise<TasksResult>;
  unassignTasks(wsId: string, ids: string[], meta?: TimelineMeta): Promise<TasksResult>;
  /**
   * The box is gone (destroyed, or pruned): every task on it goes back to the
   * backlog and every manager drops it.
   */
  boxGone(boxId: string): Promise<void>;
  /** `ids` must be an exact permutation of the workspace's tasks. */
  reorderTasks(wsId: string, ids: string[], meta?: TimelineMeta): Promise<TasksResult>;

  /** projectId -> workspaceId, for `Project.workspaceId` in getData(). */
  workspaceIdByProject(): Promise<Map<string, string>>;
  /** Task roll-ups for `Box.tasks`, keyed by box id and by pending create-job id. */
  taskSummaries(): Promise<{
    byBox: Map<string, BoxTaskSummary>;
    byJob: Map<string, BoxTaskSummary>;
  }>;
}
