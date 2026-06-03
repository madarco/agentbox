/**
 * `Provider` — the top-level abstraction the CLI routes every box command
 * through. One implementation per backend: `DockerProvider` for local Docker
 * containers, a cloud-backed provider per cloud (Daytona, ...). The CLI never
 * talks to a backend directly; it resolves a `Provider` from a box's
 * `provider` discriminator (or, for `create`, from config/flags) and calls it.
 */

import type { BoxRecord, ProviderName } from './box-record.js';
import type { BoxEndpoints } from './endpoints.js';
import type { BoxResourceStats } from './types.js';

/** Coarse lifecycle state, identical across providers. */
export type BoxRuntimeState = 'running' | 'paused' | 'stopped' | 'missing';

/** Resource ceilings requested for a new box. `null` means unlimited/unset. */
export interface CreateBoxLimits {
  memoryBytes: number | null;
  cpus: number | null;
  pidsLimit: number | null;
  disk: string | null;
}

/**
 * One fully resolved carry entry, as approved by the host CLI's carry prompt.
 * Cross-provider — both DockerProvider and the cloud providers apply these the
 * same way: tar the host `absSrc`, extract at the box-side `absDest` (with
 * `~/` expanded against the in-box `$HOME` at copy time). Kept on `core` so the
 * Provider seam doesn't depend on apps/cli.
 */
export interface ResolvedCarryEntry {
  rawSrc: string;
  rawDest: string;
  absSrc: string;
  absDest: string;
  kind: 'file' | 'dir' | 'missing';
  bytes?: number;
  mode?: number;
  /**
   * Numeric uid that should own the carried file inside the box. When unset,
   * the per-provider copy step defaults to 1000 (the in-box `vscode` user).
   * Set 0 (root) to skip the chown and leave the extract owner intact.
   */
  user?: number;
  optional: boolean;
  symlinkInfo?: 'safe' | 'outside-home';
}

export interface CreateBoxRequest {
  workspacePath: string;
  name?: string;
  /** Project root (nearest ancestor with agentbox.yaml, else workspacePath). */
  projectRoot: string;
  /** Override the base image / snapshot. */
  image?: string;
  /**
   * Try the public registry before building the docker base image. Defaults
   * to true. `--build` / `box.imageRegistry=""` set this false. Docker only.
   */
  allowPull?: boolean;
  /**
   * Registry repo for the docker base-image pull. Defaults to
   * `BOX_IMAGE_REGISTRY`; empty disables pulling. Docker only.
   */
  imageRegistry?: string;
  /** Start from this checkpoint ref instead of a cold image. */
  checkpointRef?: string;
  withPlaywright?: boolean;
  withEnv?: boolean;
  /** Workspace-relative host file paths to seed into /workspace at create. */
  envFilesToImport?: string[];
  /**
   * Approved host→box file copies from `agentbox.yaml`'s `carry:` block.
   * Each entry is extracted at its declared `absDest` (not under /workspace).
   * Empty / undefined → no carry. The host CLI is responsible for resolution
   * and user approval before threading entries in here.
   */
  carry?: ResolvedCarryEntry[];
  vnc?: { enabled: boolean };
  limits?: CreateBoxLimits;
  /**
   * Cap on commits shipped in the cloud-seed git bundle (daytona, hetzner).
   * `undefined` → adaptive default (last 200 commits, re-bundle at 100 if the
   * result exceeds 20 MB). `0` → full history (`git bundle create --all`).
   * `> 0` → fixed shallow depth, adaptive size check disabled.
   * Ignored by the docker provider (it bind-mounts `.git/`, no bundle).
   */
  bundleDepth?: number;
  /**
   * Base ref the box's per-box branch (`agentbox/<name>`) is created from.
   * When unset, the worktree forks from `HEAD` (current behavior). When set,
   * accepts any ref `git rev-parse --verify` resolves on the host main repo
   * (`main`, `origin/main`, SHAs, tags, …). The CLI is responsible for
   * validating + optionally fetching first so a bad ref fails fast before
   * any provider work — the provider trusts whatever it gets here.
   */
  fromBranch?: string;
  /**
   * Reuse an existing branch directly instead of forking a fresh
   * `agentbox/<name>` branch. The box checks out `<useBranch>` as-is (root
   * repo only); commits and `git push` flow straight to it. Mutually
   * exclusive with `fromBranch` (the CLI enforces this). Docker: `git
   * worktree add <wt> <branch>` (no `-b`) — fails if the host already has
   * the branch checked out. Cloud: the clone lands on the branch and we skip
   * the `checkout -B` rename. The CLI validates the branch exists host-side
   * before any provider work.
   */
  useBranch?: string;
  /**
   * When starting from a checkpoint, merge the host's current branch into the
   * restored worktree + overlay its uncommitted/untracked changes (box wins on
   * conflict). Defaults to true. Docker-honored; cloud providers ignore it for
   * now (Phase 2).
   */
  resyncOnStart?: boolean;
  /** Provider-specific knobs (docker: sharedCache/portless; daytona: resources/region). */
  providerOptions?: Record<string, unknown>;
  onLog?: (line: string) => void;
}

export interface CreatedBox {
  record: BoxRecord;
  /** True when the provider had to build/provision the base image just now. */
  imageBuilt?: boolean;
  /**
   * Result of the on-create workspace resync (the checkpoint-restore path
   * merges the box up to the host's current branch). Absent when no resync
   * ran (e.g. a non-checkpoint fresh create, which already forks from HEAD).
   */
  resync?: ResyncResult;
}

/**
 * Outcome of a host→box workspace resync (`Provider.resyncWorkspace`): merge
 * the host's current branch into the box's per-box branch and overlay the
 * host's uncommitted/untracked changes, favoring the box on conflict. Conflicts
 * are not left as markers — the host change is skipped and the box's version
 * kept — and reported here so the caller can warn the agent.
 */
export interface ResyncResult {
  repos: {
    /** Agent-visible worktree path (`/workspace` or `/workspace/<sub>`). */
    containerPath: string;
    /** Paths where merging host commits conflicted; box version kept. */
    mergeConflicts: string[];
    /** Paths where overlaying host uncommitted/untracked was skipped to keep the box version. */
    overlaySkipped: string[];
  }[];
  /** True if any repo skipped a host change to keep the box version. */
  hadConflicts: boolean;
}

export interface InspectedBox {
  record: BoxRecord;
  state: BoxRuntimeState;
  endpoints: BoxEndpoints;
  /** Provider-native raw inspect payload, opaque to the CLI (debug output only). */
  raw?: unknown;
}

export interface ExecOptions {
  user?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** What kind of interactive session the CLI wants an attach argv for. */
export type AttachKind = 'shell' | 'agent' | 'logs';

/** An interactive session the CLI's PTY wrapper attaches to. */
export interface AttachSpec {
  /** argv the wrapper spawns locally to attach to the box. */
  argv: string[];
  /**
   * Extra environment for the spawned argv (merged over `process.env`). Used by
   * the Vercel provider to pass `VERCEL_AUTH_TOKEN` to the `sbx` CLI without
   * leaking it into the process argv.
   */
  env?: Record<string, string>;
  /** Optional cleanup invoked after the PTY detaches. */
  cleanup?: () => Promise<void>;
}

export interface BuildAttachOptions {
  sessionName?: string;
  user?: string;
  /** For `logs`: which service to tail. */
  service?: string;
  tail?: number;
  follow?: boolean;
  /**
   * For `agent`/`shell`: the inner command tmux should spawn when no session
   * is running yet. E.g. `'/home/vscode/.local/bin/claude'` for the claude
   * agent attach, `'bash -l'` for a plain shell. Cloud `buildAttach` runs it
   * via `tmux new-session -A -s <sessionName> '<command>'` so an existing
   * session attaches and a fresh one starts the right program.
   */
  command?: string;
  /** Plain (non-tmux) attach: skip the tmux wrap, just run `command` directly. */
  noTmux?: boolean;
  /**
   * Build a "create the tmux session detached, do NOT attach" argv instead of
   * an interactive attach. The CLI uses this to pre-start a cloud session with
   * its full launch `command` (e.g. `claude --resume <id>`) before opening the
   * attach in a new terminal tab — the new tab re-invokes `agentbox <agent>
   * attach` without those args, so without a pre-start it would create the
   * session fresh. With the session already running, the re-invoked attach
   * finds it (`tmux has-session`) and just attaches. Cloud providers honor
   * this; Docker ignores it (its sessions start at create time anyway).
   */
  detached?: boolean;
}

/** Optional checkpoint capability — not every provider supports it. */
export interface ProviderCheckpoint {
  create(box: BoxRecord, name: string): Promise<{ ref: string }>;
  list(projectRoot: string): Promise<{ ref: string; createdAt: string }[]>;
  remove(projectRoot: string, ref: string): Promise<void>;
}

/**
 * Options for `Provider.prepare` — the provider-neutral "bake the base image"
 * step (`agentbox prepare --provider <name>`). Each provider interprets these
 * within its own image-build primitive; common to all is "this is the one-time
 * setup that lets subsequent `create`s skip the slow build path".
 */
export interface PrepareOptions {
  /**
   * User-facing snapshot/image name. Providers may default this (e.g. the
   * daytona provider uses `agentbox-base-<timestamp>` when omitted). Docker
   * ignores it — the local image tag is hard-coded.
   */
  name?: string;
  /**
   * Host-absolute workspace path being prepared for. Threaded into
   * `stageClaudeStaticForUpload`'s `_claude.json` rewrite so the baked
   * snapshot's `projects[<hostWorkspace>]` aliases to `projects['/workspace']`.
   * Defaults to `process.cwd()` in the CLI entry.
   */
  hostWorkspace?: string;
  /**
   * When true, rebuild even if an existing prepared image/snapshot is
   * detected. Docker's prepare is otherwise idempotent (skips when
   * `imageExists('agentbox/box:dev')`); daytona always builds a fresh
   * snapshot under a new name when not given one.
   */
  force?: boolean;
  /**
   * Try the public registry before building. Docker only: when true (default)
   * `prepare` pulls the fingerprint-tagged base image and retags it locally,
   * falling back to a build on a miss. `--build` / `box.imageRegistry=""`
   * set this false to force a local build. Ignored by cloud providers.
   */
  allowPull?: boolean;
  /**
   * Registry repo to pull the docker base image from. Defaults to
   * `BOX_IMAGE_REGISTRY`; empty string disables pulling. Docker only.
   */
  registry?: string;
  /**
   * Progress sink for the build-side log stream (Docker BuildKit output,
   * Daytona's `onLogs` chunks). Wired to the CLI spinner / latest.log.
   */
  onLog?: (line: string) => void;
}

/** Result of `Provider.prepare`. */
export interface PrepareResult {
  /**
   * For providers that produce a named snapshot the user should pin via
   * `box.image: <name>`, this is the registered name. Docker leaves it
   * undefined (the local image tag isn't config-pinned).
   */
  snapshotName?: string;
}

export interface Provider {
  readonly name: ProviderName;

  // ---- lifecycle ----
  create(req: CreateBoxRequest): Promise<CreatedBox>;
  /** Bring a stopped/paused box back; returns the record with refreshed fields. */
  start(box: BoxRecord): Promise<BoxRecord>;
  pause(box: BoxRecord): Promise<void>;
  resume(box: BoxRecord): Promise<void>;
  stop(box: BoxRecord): Promise<void>;
  destroy(box: BoxRecord, opts?: { keepSnapshot?: boolean }): Promise<void>;

  /**
   * Resync the box's workspace with the host's current state: merge the host's
   * checked-out branch into the box's per-box branch and overlay the host's
   * uncommitted/untracked changes, keeping the box's version on conflict. The
   * CLI calls this on agent-session starts (gated by `box.resyncOnStart`).
   * Optional — providers that can't reach a live host workspace omit it and the
   * CLI skips resync for that provider.
   */
  resyncWorkspace?(box: BoxRecord): Promise<ResyncResult>;

  // ---- query ----
  inspect(box: BoxRecord): Promise<InspectedBox>;
  /** Cheap state probe used by `list` in a tight loop. */
  probeState(box: BoxRecord): Promise<BoxRuntimeState>;
  stats?(box: BoxRecord): Promise<BoxResourceStats>;

  // ---- exec / sessions ----
  exec(box: BoxRecord, argv: string[], opts?: ExecOptions): Promise<ExecResult>;

  // ---- url / endpoints ----
  /**
   * Resolve the user-facing URL to open in the host browser.
   *
   * - `kind: 'web'` (default) — the box's exposed web app (Docker: port 80
   *   via OrbStack/Portless/loopback; cloud: the supervisor's WebProxy port).
   * - `kind: 'vnc'` — the in-box noVNC viewer (port 6080).
   * - `loopback` — Docker-only knob to prefer `127.0.0.1:<port>` over the
   *   engine's auto-routed URL; ignored by cloud providers.
   * - `ttl` — cloud-only hint for signed-URL expiry in seconds (cloud
   *   providers default to 3600 when omitted; Docker providers ignore it).
   */
  resolveUrl(
    box: BoxRecord,
    opts?: { loopback?: boolean; kind?: 'web' | 'vnc'; ttl?: number },
  ): Promise<string>;

  // ---- optional capabilities (the CLI feature-detects these) ----
  /** Build the argv the CLI's PTY wrapper attaches to (shell/agent/logs). */
  buildAttach?(box: BoxRecord, kind: AttachKind, opts?: BuildAttachOptions): Promise<AttachSpec>;
  uploadPath?(box: BoxRecord, hostSrc: string, boxDst: string): Promise<{ finalPath: string }>;
  downloadPath?(box: BoxRecord, boxSrc: string, hostDst: string): Promise<{ finalPath: string }>;
  /**
   * Pull the *contents* of an in-box directory into a host directory —
   * `/workspace/*` → `<hostDst>/*`, not `<hostDst>/<srcBasename>/*`. Used by
   * `agentbox download` for the bulk workspace pull. Docker providers don't
   * need this (the rsync path in `pullToHost` already handles it); cloud
   * providers do because their `downloadPath` matches docker-cp semantics.
   */
  downloadDirContents?(box: BoxRecord, boxSrc: string, hostDst: string): Promise<{ finalPath: string }>;
  checkpoint?: ProviderCheckpoint;
  /**
   * Extract the box's agent login credentials (claude/codex/opencode) from the
   * running box back to the host backups under `~/.agentbox`, so the next box
   * is seeded with the captured login. Cloud-only: the box has no shared volume
   * to persist a login across destroys (docker shares the host's real auth
   * paths already, so it omits this). The CLI calls it on `checkpoint create
   * --set-default`. Returns the agents whose host backup was updated.
   */
  extractAgentCredentials?(box: BoxRecord): Promise<string[]>;
  /**
   * One-time "build the base image" hook for `agentbox prepare --provider`.
   * Docker builds the local Dockerfile.box image; daytona builds a layered
   * Image (Dockerfile.box + host agent static config) and registers it as a
   * named snapshot. Optional — providers without an image-build primitive
   * omit it and the CLI surfaces a clear "prepare not supported" error.
   */
  prepare?(opts: PrepareOptions): Promise<PrepareResult>;
  /**
   * Compute the CURRENT build-context fingerprint for this provider's base
   * image / snapshot WITHOUT building anything. Side-effect-free: resolves
   * the same runtime assets `prepare` would bake in, hashes them, and
   * returns the SHA-256.
   *
   * The CLI compares this against the stored fingerprint in
   * `~/.agentbox/<provider>-prepared.json` (`base.contextSha256`) to decide
   * whether the user's local install has drifted from the baked base — i.e.
   * a CLI/runtime upgrade that changed any baked file. Staleness is decided
   * PURELY by content hash; CLI version strings stored alongside are
   * informational and MUST NOT influence freshness decisions.
   *
   * Returns `undefined` when the assets can't be resolved (e.g. a dev tree
   * without `pnpm -w build`); callers degrade to "don't nag" rather than
   * flag a false stale.
   */
  baseFingerprint?(): Promise<string | undefined>;
}
