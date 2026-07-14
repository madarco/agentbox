/**
 * `Provider` — the top-level abstraction the CLI routes every box command
 * through. One implementation per backend: `DockerProvider` for local Docker
 * containers, a cloud-backed provider per cloud (Daytona, ...). The CLI never
 * talks to a backend directly; it resolves a `Provider` from a box's
 * `provider` discriminator (or, for `create`, from config/flags) and calls it.
 */

import type { BoxRecord, ProviderName, SshTargetRecord } from './box-record.js';
import type { InboundPolicy } from './cloud-backend.js';
import type { BoxEndpoints } from './endpoints.js';
import type { ReplaceRule } from './replace.js';
import type { BoxResourceStats } from './types.js';
import type { SyncTransport } from './sync/transport.js';
import type { ProviderSync } from './sync/provider-sync.js';

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
  /**
   * tar `--exclude` patterns (already expanded) applied when packing a `dir`
   * entry, so heavy/regenerable subtrees (node_modules, .git, ...) don't ride
   * along. Set by the host resolver; ignored for `file`/`missing` entries.
   */
  exclude?: string[];
  /**
   * Substitute `{{AGENTBOX_*}}` whitelist placeholders in the file content
   * before copying (host-side). File entries only.
   */
  replaceEnvs?: boolean;
  /**
   * Custom replacement rules applied (in order) to the file content before
   * copying. Named `replacements:` rule-sets are already expanded into this
   * list by the host resolver. File entries only.
   */
  replace?: ReplaceRule[];
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
   * `box.credentialSync` resolved by the caller (`false` = disable the in-box
   * credential watcher; stamped into the box as `AGENTBOX_CREDENTIAL_SYNC=0`).
   * Undefined → the provider resolves the config key itself. The CLI threads
   * it so `--no-credential-sync` (a CLI override the provider's own config
   * load can't see) actually reaches the box.
   */
  credentialSync?: boolean;
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
  /**
   * Seed /workspace by cloning inside the box instead of host-seeding. When set,
   * cloud providers skip the host-side `seedCloudWorkspace` and the in-box
   * bootstrap clones `authedUrl` (a leased, token-bearing URL) into /workspace,
   * then resets origin to `originUrl` (scrubbing the token). Used by the plane /
   * cloud-IDE create path, which has no host checkout to seed from; the laptop
   * path omits this and host-seeds (carrying local uncommitted state). Cloud
   * only — the docker provider bind-mounts the host `.git` and never clones.
   */
  inBoxClone?: { authedUrl: string; originUrl: string; branch?: string };
  /**
   * Hosted control-plane base URL when this box's live relay IS the plane (cloud
   * only). When set, the provider resolves `topology: 'control-plane'`, registers
   * the box on the plane with its origin URL, and the box's in-box daemon
   * forwards `/rpc` to the plane + pushes via a leased token (`AGENTBOX_GIT_LEASE`).
   * Absent → classic host-side sync (`'cloud'`/`'docker'`). Docker ignores it.
   */
  controlPlaneUrl?: string;
  /**
   * Git push routing (`git.pushMode`): `'auto' | 'relay' | 'lease' | 'direct'`.
   * Mirrors config's `GitPushMode` (core doesn't depend on config). Threaded to
   * the box bootstrap to gate `AGENTBOX_GIT_LEASE` / `AGENTBOX_GIT_DIRECT`.
   * Docker ignores it (always relay).
   */
  gitPushMode?: 'auto' | 'relay' | 'lease' | 'direct';
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
  /**
   * Typed into the PTY immediately after spawn, as if the user had entered it.
   *
   * For transports that only allocate a terminal for a *shell* session and not
   * for an exec one (Daytona's SSH gateway: `ssh -tt host 'cmd'` lands on "not
   * a tty", while `ssh -tt host` gets a real /dev/pts). Interactive attach needs
   * a terminal — tmux exits instantly without one — so those backends connect
   * with NO remote command and hand the command over on stdin instead.
   */
  initialInput?: string;
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
   * How the bake installs Claude Code: `native` (Anthropic's installer, the
   * default) or `npm` (`@anthropic-ai/claude-code`). Threaded into each
   * provider's install script (`AGENTBOX_CLAUDE_INSTALL` env) or Dockerfile
   * build-arg. An opt-in fallback for cloud egress IPs whose CDN the native
   * installer 403s. Bake-time only — resolved from `box.claudeInstall`.
   */
  claudeInstall?: 'native' | 'npm';
  /**
   * Bake-time VM size for providers whose resources are fixed at snapshot/
   * template-build time (daytona: `cpu-memory-disk` GB, e.g. `4-8-20`; e2b:
   * `cpu-memory` GB, e.g. `4-8`). Resolved by the CLI from `--size` /
   * `box.size<Provider>` / `box.size`. Docker/hetzner/vercel ignore it (their
   * size is a per-create knob, not baked).
   */
  size?: string;
  /**
   * Datacenter / region the bake VPS is created in. Hetzner reads it (defaults
   * to `box.hetznerLocation`, else `nbg1`); Daytona reads it as the region the
   * base snapshot is registered in — which matters because only `us-east-1` has
   * linux-vm runners. Other providers ignore it (their base template/snapshot
   * has no per-region placement at bake time).
   */
  location?: string;
  /**
   * SSH destination whose Docker engine the bake targets, for providers whose
   * "cloud" is a machine the user supplies (`remote-docker`). Resolved by the
   * CLI from `--provider docker:<host>` / `--remote-host` / `box.remoteDockerHost`.
   * Ignored by every provider that owns its own infrastructure.
   */
  host?: string;
  /**
   * Sandbox class to bake for. Daytona only (`linux-vm` | `container`) — the
   * class is a property of the *snapshot*, and a snapshot of one class cannot
   * create a sandbox of the other, so it must be fixed at bake time. Resolved
   * from `box.daytonaClass`.
   */
  sandboxClass?: string;
  /**
   * Explicit registry image the daytona `linux-vm` base is baked from
   * (`box.daytonaVmBaseImage`), bypassing the fingerprint-tagged published
   * image. The escape hatch for a build context CI never published — chiefly a
   * locally modified `Dockerfile.box`. Daytona-only.
   */
  vmBaseImage?: string;
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
  /**
   * Re-establish host-side connectivity to a box that is (or should be) already
   * running, WITHOUT power-cycling it: re-resolve preview URLs, re-open the
   * host transport (Hetzner SSH tunnel + forwards), re-register host portless
   * aliases, relaunch the in-box daemons, and re-register with the host relay.
   * Used by `agentbox recover` after a host reboot / relay restart, and after
   * adopting a box that was missing from local state. If the box turns out to be
   * paused/stopped, providers fall back to `start`/`resume` (which power-cycle).
   * Returns the record with refreshed fields. Defaults to `start` when a
   * provider has no cheaper reconnect path.
   */
  reconnect(box: BoxRecord): Promise<BoxRecord>;
  /**
   * Self-heal host→box reachability when establishing a connection fails for a
   * reason the provider can repair. Today only the Hetzner cloud provider acts:
   * a host egress-IP change locks the per-box firewall, so this re-syncs it to
   * the current egress — but ONLY when it actually changed (`{ changed: false }`
   * otherwise, so the caller rethrows the original error). The CLI calls it ONLY
   * on a connection-ESTABLISHMENT failure (`recover`, the initial attach
   * connect), never on a mid-session drop. Optional — docker and public-URL
   * clouds omit it.
   */
  repairReachability?(box: BoxRecord): Promise<{ changed: boolean; detail?: string }>;
  /**
   * Apply an inbound-access policy to a VPS box's per-box firewall (`agentbox
   * inbound <box> open|lock|whitelist …`). Parses the spec, applies it via the
   * backend (host egress re-detected for locked/whitelist), persists the policy
   * on the record, and returns it. Optional — only the hetzner / digitalocean
   * cloud providers implement it; others throw a "not supported" error via the
   * CLI. `onLog` streams the applied source list.
   */
  setInbound?(box: BoxRecord, spec: string, onLog?: (line: string) => void): Promise<InboundPolicy>;
  /**
   * Switch an already-running cloud box into `git.pushMode=direct` — the
   * post-create equivalent of `--dangerously-with-credentials`. Uploads the
   * host-resolved credential carry `entries` into the box, wires its git config
   * (`seedGitCredentials`), sets `AGENTBOX_GIT_DIRECT=1` in the box env, and
   * persists `cloud.gitPushMode=direct` so a resume re-kick keeps it. The
   * caller (CLI) runs the interactive token-vs-ssh gate to produce `entries`.
   * Optional — only cloud providers implement it; docker omits it (it
   * bind-mounts the host `.git`, so direct mode is N/A). A currently-running
   * agent session must be restarted to pick up the new mode.
   */
  enableDirectGit?(
    box: BoxRecord,
    entries: ResolvedCarryEntry[],
    opts?: { hostRepo?: string; onLog?: (line: string) => void },
  ): Promise<void>;
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
   * CLI skips resync for that provider. `onLog` streams progress to the CLI
   * spinner (the underlying resync concern logs per-repo merge/overlay lines).
   */
  resyncWorkspace?(box: BoxRecord, onLog?: (line: string) => void): Promise<ResyncResult>;

  /**
   * The co-located `ProviderSync` facade for an already-created box: every
   * shared sync op (resync, agent config, credentials, env, carry, git identity)
   * named once, each a thin delegation to the provider-neutral concern. The
   * handle is closed from `box` at construction. `create()` builds the same
   * facade directly from raw handles (no record yet) and walks it. Optional —
   * providers wire this as they adopt the facade (Phase 7).
   */
  sync?(box: BoxRecord): ProviderSync;

  /**
   * Build the byte-mover the sync layer drives for operations on an already-
   * created box (session-start resync, `cp`, credential extract, download).
   * At create time the provider constructs its transport internally instead.
   * Optional — providers wire this as they migrate concerns onto the seam.
   */
  syncTransport?(box: BoxRecord): SyncTransport;

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
  /**
   * The box's SSH connection target, for `agentbox open` (sshfs) / `code`
   * (Remote-SSH) / `connect`. Providers that omit it fall back to parsing the
   * `buildAttach` argv, which only works when that argv is a plain `ssh …
   * <user>@<box>` — true when the box IS the machine (hetzner), false when the
   * attach has to go THROUGH a machine to reach the box.
   *
   * remote-docker implements it: its box is a container on someone else's
   * engine, so the target is `127.0.0.1:<published sshd port>` reached via a
   * `proxyJump` through the engine. Implementations are responsible for making
   * the box actually reachable (installing the per-box key, starting sshd) —
   * this is called on the paths that persist `box.ssh`.
   *
   * Returns null when the box has no SSH target right now (e.g. sshd failed to
   * come up); callers then skip the alias rather than writing a broken one.
   */
  sshTarget?(box: BoxRecord): Promise<SshTargetRecord | null>;
  uploadPath?(
    box: BoxRecord,
    hostSrcs: string[],
    boxDst: string,
    exclude?: string[],
  ): Promise<{ finalPath: string }>;
  downloadPath?(
    box: BoxRecord,
    boxSrcs: string[],
    hostDst: string,
    exclude?: string[],
  ): Promise<{ finalPath: string }>;
  /**
   * Pull the *contents* of an in-box directory into a host directory —
   * `/workspace/*` → `<hostDst>/*`, not `<hostDst>/<srcBasename>/*`. Used by
   * `agentbox download` for the bulk workspace pull. Docker providers don't
   * need this (the rsync path in `pullToHost` already handles it); cloud
   * providers do because their `downloadPath` matches docker-cp semantics.
   */
  downloadDirContents?(
    box: BoxRecord,
    boxSrc: string,
    hostDst: string,
  ): Promise<{ finalPath: string }>;
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
   *
   * `claudeInstall` MUST match the mode the base was baked with (from
   * `box.claudeInstall`), because `prepare` folds it into the stored
   * fingerprint via `claudeInstallFingerprint`. Omitting it makes an
   * npm-baked base always read as stale.
   */
  baseFingerprint?(claudeInstall?: 'native' | 'npm'): Promise<string | undefined>;
}
