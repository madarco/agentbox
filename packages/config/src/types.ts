/**
 * Layered user config. The same shape is accepted at three layers:
 *   - global   ~/.agentbox/config.yaml
 *   - project  ~/.agentbox/projects/<hash>/config.yaml
 *   - workspace  defaults: block in ./agentbox.yaml
 *
 * Plus a CLI-flag layer at runtime. Precedence (highest wins):
 *   cli > workspace > project > global > built-in defaults.
 */

import {
  PROVIDERS,
  PROVIDER_NAMES,
  perProviderConfigKey,
  type ProviderKind,
} from './providers.js';

export type IdeFlavor = 'vscode' | 'cursor' | 'auto';
export type EngineKind = 'orbstack' | 'docker-desktop' | 'other' | 'auto';
export type BrowserKind = 'agent-browser' | 'playwright' | 'both';
/** Sandbox backend new boxes are created on. Defined in `providers.ts` (the single source of truth) and re-exported here for back-compat. */
export type { ProviderKind };
/**
 * How the base image/snapshot installs Claude Code at bake time. `native`
 * (Anthropic's installer, the default) or `npm` (`@anthropic-ai/claude-code`) —
 * an opt-in fallback for cloud egress IPs whose CDN the native installer 403s.
 */
export type ClaudeInstallMethod = 'native' | 'npm';
/**
 * How a box's `git push` reaches GitHub:
 * - `relay` — the box asks the host relay to push with the HOST's credentials
 *   (they never enter the box). Docker boxes always use this; for a cloud box it
 *   runs through the host relay's cloud poller (git-bundle pull-back).
 * - `lease` — the relay/plane leases a short-lived GitHub-App token and the box
 *   pushes directly with it (keeps working with the laptop off). Needs a
 *   reachable relay/plane with a GitHub App configured.
 * - `direct` — the box holds a COPY of your git credentials (token + SSH key)
 *   and pushes/pulls/signs entirely on its own, so it keeps working with the
 *   laptop off and needs no hub. Selected via `--with-credentials`, which copies
 *   the credentials in behind a confirmation prompt. Dangerous: the credentials
 *   live inside the box and in any snapshot/checkpoint of it. Cloud boxes only.
 * - `auto` (default) — lease when a control plane is configured for the box
 *   (`relay.controlPlaneUrl`), else relay. Today's behavior.
 * Docker boxes ignore this (always `relay` — they bind-mount the host `.git`).
 */
export type GitPushMode = 'auto' | 'relay' | 'lease' | 'direct';
/** Where `agentbox claude|codex|opencode` opens the attached session when the host
 *  shell is running inside tmux, cmux, Herdr, or iTerm2. `same` keeps today's inline behavior. */
export type AttachOpenIn = 'split' | 'window' | 'tab' | 'same';
/** Where a background `-i` (queued) run opens the box once the worker has created
 *  it. `none` (default) opens nothing — the historical behavior. The open is
 *  driven by the host relay's queue worker when the box becomes ready, not at
 *  submit time, so there is no `same` (inline) mode here. */
export type QueueOpenIn = 'none' | 'split' | 'window' | 'tab';

export interface UserConfig {
  /**
   * Config-file shape version. Stamped to `1` on first write so future
   * migrations (e.g. a renamed key, a leaf-shape change) have a stable
   * read-time discriminator. No behavioural effect yet — placeholder for
   * later. Loader strips it before merge so it never leaks into
   * `EffectiveConfig`.
   */
  schema?: number;
  box?: {
    provider?: ProviderKind;
    hostSnapshot?: boolean;
    defaultCheckpoint?: string;
    /** Per-provider override of `defaultCheckpoint`. Resolved before falling back to the global. */
    defaultCheckpointDocker?: string;
    defaultCheckpointDaytona?: string;
    defaultCheckpointHetzner?: string;
    defaultCheckpointVercel?: string;
    defaultCheckpointE2b?: string;
    defaultCheckpointDigitalocean?: string;
    defaultCheckpointRemoteDocker?: string;
    /**
     * Generic VM-size fallback for cloud providers. Provider-interpreted:
     * Hetzner = server type string (e.g. `cx33`); Daytona = `cpu-memory-disk`
     * GB spec (e.g. `4-8-20`); Vercel = vCPU count (`1`/`2`/`4`/`8`);
     * E2B = `cpu-memory` GB spec (e.g. `4-8`), applied at `prepare` time.
     * Per-provider `size{Provider}` wins over this. Docker ignores it (it uses
     * `memory`/`cpus`/`disk`).
     */
    size?: string;
    sizeDocker?: string;
    sizeDaytona?: string;
    sizeHetzner?: string;
    sizeVercel?: string;
    sizeE2b?: string;
    sizeDigitalocean?: string;
    sizeRemoteDocker?: string;
    withPlaywright?: boolean;
    /**
     * How the base image/snapshot installs Claude Code at bake time. Bake-time
     * only (read by `agentbox prepare`, not `create`); `npm` is a fallback for
     * cloud egress IPs the native installer's CDN 403s.
     */
    claudeInstall?: ClaudeInstallMethod;
    withEnv?: boolean;
    resyncOnStart?: boolean;
    vnc?: boolean;
    autoApproveHostActions?: boolean;
    autoApproveSafeHostActions?: boolean;
    isolateClaudeConfig?: boolean;
    isolateCodexConfig?: boolean;
    isolateOpencodeConfig?: boolean;
    image?: string;
    /**
     * Per-provider override of `image`. Written by `agentbox prepare
     * --provider <name>` so a daytona prepare can't poison a hetzner create.
     * Resolved before falling back to the generic.
     */
    imageDocker?: string;
    imageDaytona?: string;
    imageHetzner?: string;
    imageVercel?: string;
    imageE2b?: string;
    imageDigitalocean?: string;
    imageRemoteDocker?: string;
    imageRegistry?: string;
    dockerCacheShared?: boolean;
    memory?: number;
    cpus?: number;
    pidsLimit?: number;
    disk?: string;
    bundleDepth?: number;
    daytonaClass?: string;
    daytonaRegion?: string;
    daytonaTimeoutMs?: number;
    daytonaVmBaseImage?: string;
    hetznerLocation?: string;
    digitaloceanRegion?: string;
    digitaloceanProject?: string;
    remoteDockerHost?: string;
    vercelTimeoutMs?: number;
    vercelNetworkPolicy?: string;
    e2bTimeoutMs?: number;
    cpMaxBytes?: number;
    credentialSync?: boolean;
    inbound?: string;
  };
  checkpoint?: {
    maxLayers?: number;
  };
  claude?: {
    sessionName?: string;
    dangerouslySkipPermissions?: boolean;
  };
  codex?: {
    sessionName?: string;
    dangerouslySkipPermissions?: boolean;
  };
  opencode?: {
    sessionName?: string;
  };
  attach?: {
    openIn?: AttachOpenIn;
    cmuxStatus?: boolean;
    herdrStatus?: boolean;
  };
  code?: {
    ide?: IdeFlavor;
    wait?: boolean;
    timeoutMs?: number;
    autoTerminals?: boolean;
  };
  shell?: {
    user?: string;
    login?: boolean;
    tmux?: boolean;
  };
  ssh?: {
    autoConfig?: boolean;
  };
  engine?: {
    kind?: EngineKind;
  };
  browser?: {
    default?: BrowserKind;
  };
  relay?: {
    port?: number;
    /**
     * Public HTTPS URL of a deployed control plane (the hosted Next.js +
     * Postgres app). When set, newly created cloud boxes point at it for their
     * centralized concerns — git-token leasing, permission state, the box
     * registry/events — and push to GitHub directly with a leased token, so
     * they keep working with the laptop off. Empty/unset = laptop-local relay
     * (the default). Set via `agentbox hub set-url`.
     */
    controlPlaneUrl?: string;
    /**
     * Per-request body cap (bytes) for custody PUTs. Defaults to 32 MiB.
     * Custody carries a project's untracked-files seed tarball, which the
     * relay's 1 MiB control-plane body cap is far too small for; this is scoped
     * to custody so every other route keeps that cap.
     *
     * Two sides enforce it independently: on a PC this governs how large a seed
     * blob the client will try to upload, while a **control box** enforces its
     * own cap from `AGENTBOX_CUSTODY_MAX_BODY_BYTES`. Raising only this one lets
     * the client offer a blob the control box then refuses — the push drops that
     * blob and continues, so raise both to actually admit a bigger seed.
     */
    custodyMaxBodyBytes?: number;
  };
  git?: {
    pushMode?: GitPushMode;
  };
  vnc?: {
    containerPort?: number;
  };
  portless?: {
    enabled?: boolean;
    stateDir?: string;
  };
  autopause?: {
    enabled?: boolean;
    maxRunningBoxes?: number;
    idleMinutes?: number;
  };
  queue?: {
    enabled?: boolean;
    maxConcurrent?: number;
    maxWorking?: number;
    idleGraceSeconds?: number;
    openIn?: QueueOpenIn;
  };
  cloud?: {
    useCurrentBranch?: boolean;
    viaHub?: boolean;
  };
  maintenance?: {
    pruneProjectConfigs?: boolean;
    pruneProjectConfigsEvery?: number;
  };
  update?: {
    /**
     * Daily background check for a newer published CLI (npm registry) and
     * tray app (release sha sidecar), plus the "newer version available"
     * nudge it feeds. At most one network probe per 24h; `false` disables
     * both the probe and the nudge.
     */
    check?: boolean;
  };
  integrations?: {
    notion?: {
      enabled?: boolean;
    };
    linear?: {
      enabled?: boolean;
    };
  };
}

/**
 * Required-everywhere variant returned as the merged effective config. Each
 * leaf is filled from BUILT_IN_DEFAULTS when no layer set it.
 *
 * `box.hostSnapshot` and `portless.enabled` are intentionally
 * `boolean | undefined` (unprompted): the default is "ask the user", expressed
 * as undefined.
 */
export interface EffectiveConfig {
  box: {
    provider: ProviderKind;
    hostSnapshot: boolean | undefined;
    defaultCheckpoint: string;
    defaultCheckpointDocker: string;
    defaultCheckpointDaytona: string;
    defaultCheckpointHetzner: string;
    defaultCheckpointVercel: string;
    defaultCheckpointE2b: string;
    defaultCheckpointDigitalocean: string;
    defaultCheckpointRemoteDocker: string;
    size: string;
    sizeDocker: string;
    sizeDaytona: string;
    sizeHetzner: string;
    sizeVercel: string;
    sizeE2b: string;
    sizeDigitalocean: string;
    sizeRemoteDocker: string;
    withPlaywright: boolean;
    claudeInstall: ClaudeInstallMethod;
    withEnv: boolean;
    resyncOnStart: boolean;
    vnc: boolean;
    autoApproveHostActions: boolean;
    autoApproveSafeHostActions: boolean;
    isolateClaudeConfig: boolean;
    isolateCodexConfig: boolean;
    isolateOpencodeConfig: boolean;
    image: string;
    imageDocker: string;
    imageDaytona: string;
    imageHetzner: string;
    imageVercel: string;
    imageE2b: string;
    imageDigitalocean: string;
    imageRemoteDocker: string;
    imageRegistry: string;
    dockerCacheShared: boolean;
    memory: number;
    cpus: number;
    pidsLimit: number;
    disk: string;
    bundleDepth: number | undefined;
    daytonaClass: string;
    daytonaRegion: string;
    daytonaTimeoutMs: number;
    daytonaVmBaseImage: string;
    hetznerLocation: string;
    digitaloceanRegion: string;
    digitaloceanProject: string;
    remoteDockerHost: string;
    vercelTimeoutMs: number;
    vercelNetworkPolicy: string;
    e2bTimeoutMs: number;
    cpMaxBytes: number;
    credentialSync: boolean;
    inbound: string;
  };
  checkpoint: {
    maxLayers: number;
  };
  claude: {
    sessionName: string;
    dangerouslySkipPermissions: boolean;
  };
  codex: {
    sessionName: string;
    dangerouslySkipPermissions: boolean;
  };
  opencode: {
    sessionName: string;
  };
  attach: {
    openIn: AttachOpenIn;
    cmuxStatus: boolean;
    herdrStatus: boolean;
  };
  code: {
    ide: IdeFlavor;
    wait: boolean;
    timeoutMs: number;
    autoTerminals: boolean;
  };
  shell: {
    user: string;
    login: boolean;
    tmux: boolean;
  };
  ssh: {
    autoConfig: boolean;
  };
  engine: {
    kind: EngineKind;
  };
  browser: {
    default: BrowserKind;
  };
  relay: {
    port: number;
    controlPlaneUrl: string | undefined;
    custodyMaxBodyBytes: number;
  };
  git: {
    pushMode: GitPushMode;
  };
  vnc: {
    containerPort: number;
  };
  portless: {
    enabled: boolean | undefined;
    stateDir: string;
  };
  autopause: {
    enabled: boolean;
    maxRunningBoxes: number;
    idleMinutes: number;
  };
  queue: {
    enabled: boolean;
    maxConcurrent: number;
    maxWorking: number;
    idleGraceSeconds: number;
    openIn: QueueOpenIn;
  };
  cloud: {
    useCurrentBranch: boolean;
    viaHub: boolean;
  };
  maintenance: {
    pruneProjectConfigs: boolean;
    pruneProjectConfigsEvery: number;
  };
  update: {
    check: boolean;
  };
  integrations: {
    notion: {
      enabled: boolean;
    };
    linear: {
      enabled: boolean;
    };
  };
}

export type ConfigSource = 'cli' | 'workspace' | 'project' | 'global' | 'default';

export interface ConfigLayer {
  source: ConfigSource;
  /** File path the layer was loaded from. Absent for `cli` and `default`. */
  path?: string;
  values: Partial<UserConfig>;
}

export interface LoadedConfig {
  effective: EffectiveConfig;
  layers: {
    cli: { values: Partial<UserConfig> };
    workspace: { path: string | null; values: Partial<UserConfig> };
    project: { path: string; values: Partial<UserConfig> };
    global: { path: string; values: Partial<UserConfig> };
    defaults: EffectiveConfig;
  };
  /** Per-leaf source map: 'box.hostSnapshot' -> 'workspace'. Powers `config get --all`. */
  sources: Record<string, ConfigSource>;
  /** Resolved project root used for the project layer (cwd if no agentbox.yaml found). */
  projectRoot: string;
  projectHash: string;
  /** True if we walked up to an agentbox.yaml; false if we fell back to cwd. */
  hasAgentboxYaml: boolean;
  /**
   * Non-fatal issues found while parsing the layers — today, unknown keys
   * (skipped, not applied). Empty on a clean load. `agentbox doctor` lists
   * these; the CLI also prints them via the warning sink (see `setConfigWarningSink`).
   */
  warnings: string[];
}

export const BUILT_IN_DEFAULTS: EffectiveConfig = {
  box: {
    provider: 'docker',
    hostSnapshot: undefined,
    defaultCheckpoint: '',
    defaultCheckpointDocker: '',
    defaultCheckpointDaytona: '',
    defaultCheckpointHetzner: '',
    defaultCheckpointVercel: '',
    defaultCheckpointE2b: '',
    defaultCheckpointDigitalocean: '',
    defaultCheckpointRemoteDocker: '',
    size: '',
    sizeDocker: '',
    sizeDaytona: '',
    sizeHetzner: '',
    sizeVercel: '',
    sizeE2b: '',
    sizeDigitalocean: '',
    sizeRemoteDocker: '',
    withPlaywright: false,
    claudeInstall: 'native',
    withEnv: false,
    resyncOnStart: true,
    vnc: true,
    autoApproveHostActions: false,
    autoApproveSafeHostActions: true,
    isolateClaudeConfig: false,
    isolateCodexConfig: false,
    isolateOpencodeConfig: false,
    image: 'agentbox/box:dev',
    imageDocker: '',
    imageDaytona: '',
    imageHetzner: '',
    imageVercel: '',
    imageE2b: '',
    imageDigitalocean: '',
    // Empty = the provider derives the fingerprint-tagged ref itself and ensures
    // it on the remote engine; set only to pin a hand-built image there.
    imageRemoteDocker: '',
    // Mirrors BOX_IMAGE_REGISTRY in @agentbox/sandbox-docker. Empty disables the
    // registry pull (always build the docker base image locally).
    imageRegistry: 'ghcr.io/madarco/agentbox/box',
    dockerCacheShared: false,
    memory: 0,
    cpus: 0,
    pidsLimit: 0,
    disk: '',
    bundleDepth: undefined,
    daytonaClass: 'linux-vm',
    // Empty = derive from the class: linux-vm implies us-east-1 (the only
    // region with VM runners), container keeps Daytona's own default.
    daytonaRegion: '',
    daytonaTimeoutMs: 1_500_000,
    // Empty = the fingerprint-tagged image CI publishes to GHCR.
    daytonaVmBaseImage: '',
    hetznerLocation: 'nbg1',
    digitaloceanRegion: 'nyc3',
    // Empty = leave boxes in the account's default project (DigitalOcean's own
    // behavior). There is no sane default id to pick — it differs per account.
    digitaloceanProject: '',
    // Empty = no default remote engine; `--provider remote-docker` then errors
    // unless the SSH destination came from `docker:<host>` / `--remote-host`.
    remoteDockerHost: '',
    vercelTimeoutMs: 2_700_000,
    vercelNetworkPolicy: '',
    e2bTimeoutMs: 2_700_000,
    cpMaxBytes: 100 * 1024 * 1024,
    credentialSync: true,
    inbound: 'locked',
  },
  checkpoint: {
    maxLayers: 3,
  },
  claude: {
    sessionName: 'claude',
    dangerouslySkipPermissions: true,
  },
  codex: {
    sessionName: 'codex',
    dangerouslySkipPermissions: true,
  },
  opencode: {
    sessionName: 'opencode',
  },
  attach: {
    openIn: 'split',
    cmuxStatus: true,
    herdrStatus: true,
  },
  code: {
    ide: 'auto',
    wait: true,
    timeoutMs: 120_000,
    autoTerminals: true,
  },
  shell: {
    user: 'vscode',
    login: true,
    tmux: true,
  },
  ssh: {
    autoConfig: true,
  },
  engine: {
    kind: 'auto',
  },
  browser: {
    default: 'agent-browser',
  },
  relay: {
    port: 8787,
    controlPlaneUrl: undefined,
    custodyMaxBodyBytes: 32 * 1024 * 1024,
  },
  git: {
    pushMode: 'auto',
  },
  vnc: {
    containerPort: 6080,
  },
  portless: {
    enabled: undefined,
    stateDir: '',
  },
  autopause: {
    enabled: true,
    maxRunningBoxes: 5,
    idleMinutes: 5,
  },
  queue: {
    enabled: true,
    maxConcurrent: 5,
    maxWorking: 0,
    idleGraceSeconds: 15,
    openIn: 'none',
  },
  cloud: {
    useCurrentBranch: false,
    viaHub: true,
  },
  maintenance: {
    pruneProjectConfigs: true,
    pruneProjectConfigsEvery: 50,
  },
  update: {
    check: true,
  },
  integrations: {
    notion: { enabled: false },
    linear: { enabled: false },
  },
};

export type KeyType = 'bool' | 'string' | 'int' | 'enum';

export interface KeyDescriptor {
  /** Dot-path, e.g. "box.snapshot". */
  key: string;
  type: KeyType;
  enumValues?: readonly string[];
  description: string;
  /** True for keys most users shouldn't touch (image, ports). Hidden from `list` by default. */
  advanced?: boolean;
}

/** Join blurbs into "a, b, c, or d" for the enum description. */
function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

/**
 * Per-provider config-key descriptors generated from the `PROVIDERS` table so a
 * new provider gets its `box.defaultCheckpoint<P>` / `box.size<P>` /
 * `box.image<P>` entries automatically. The `size`/`image` descriptions come
 * from the table (they carry provider-specific detail); the checkpoint one is
 * uniform.
 */
function perProviderCheckpointKeys(): KeyDescriptor[] {
  return PROVIDERS.map((p) => ({
    key: perProviderConfigKey('defaultCheckpoint', p.name),
    type: 'string',
    description: `Per-provider override of \`box.defaultCheckpoint\` for ${p.name}. Wins over the global when set; set via \`agentbox checkpoint set-default --provider ${p.name}\`.`,
    advanced: true,
  }));
}
function perProviderSizeKeys(): KeyDescriptor[] {
  return PROVIDERS.map((p) => ({
    key: perProviderConfigKey('size', p.name),
    type: 'string',
    description: p.sizeDesc,
    advanced: true,
  }));
}
function perProviderImageKeys(): KeyDescriptor[] {
  return PROVIDERS.map((p) => ({
    key: perProviderConfigKey('image', p.name),
    type: 'string',
    description: p.imageDesc,
    advanced: true,
  }));
}

/**
 * Single source of truth for which keys are addressable from the CLI. The
 * parser, `set`/`unset`, and `list` all walk this. Adding a key here is the
 * one place a new field has to be registered (plus the type interface above
 * and the JSON schema). Per-provider `box.{image,size,defaultCheckpoint}<P>`
 * keys are generated from the `PROVIDERS` table (see `providers.ts`).
 */
export const KEY_REGISTRY: readonly KeyDescriptor[] = [
  {
    key: 'box.provider',
    type: 'enum',
    enumValues: PROVIDER_NAMES,
    description: `Sandbox backend new boxes are created on: ${joinOr(PROVIDERS.map((p) => p.blurb))}.`,
  },
  {
    key: 'box.hostSnapshot',
    type: 'bool',
    description:
      'Use a frozen APFS clone of the host workspace as the overlay lower (default: prompt). Was box.snapshot.',
  },
  {
    key: 'box.defaultCheckpoint',
    type: 'string',
    description:
      'Checkpoint ref new boxes in this project start from when --snapshot is not given (set via `agentbox checkpoint set-default`). Used as fallback when no per-provider override is set.',
  },
  ...perProviderCheckpointKeys(),
  {
    key: 'box.size',
    type: 'string',
    description:
      'Default VM size for cloud providers. Provider-interpreted: hetzner = server type (e.g. `cx33`); daytona = `cpu-memory-disk` GB (e.g. `4-8-20`); vercel = vCPU count (1, 2, 4, 8); e2b = `cpu-memory` GB (e.g. `4-8`). Used as fallback when no per-provider override is set. Docker ignores it.',
  },
  ...perProviderSizeKeys(),
  {
    key: 'checkpoint.maxLayers',
    type: 'int',
    description:
      'Max stacked checkpoint layers before a new checkpoint is materialized merged (flattened) instead of layered.',
    advanced: true,
  },
  {
    key: 'box.withPlaywright',
    type: 'bool',
    description: 'Install @playwright/cli@latest in the box at create time.',
  },
  {
    key: 'box.claudeInstall',
    type: 'enum',
    enumValues: ['native', 'npm'] as const,
    description:
      "How `agentbox prepare` installs Claude Code into the base image/snapshot: `native` (Anthropic's installer, the default) or `npm` (@anthropic-ai/claude-code). A fallback for cloud egress IPs the native installer's CDN 403s. Bake-time only — change it, then re-run `agentbox prepare --provider <name>`.",
  },
  {
    key: 'box.withEnv',
    type: 'bool',
    description:
      'Copy host env/config files (.env*, secrets.toml, agentbox.yaml, ...) into /workspace at box create time (gitignore-bypassing).',
  },
  {
    key: 'box.resyncOnStart',
    type: 'bool',
    description:
      "Merge the host's current branch into the box and overlay the host's uncommitted/untracked changes when starting an agent session (keeps the box's version on conflict and warns the agent).",
  },
  {
    key: 'box.vnc',
    type: 'bool',
    description: 'Run the per-box Xvnc + noVNC stack.',
  },
  {
    key: 'box.autoApproveHostActions',
    type: 'bool',
    description:
      'Auto-approve host-action confirmations (git push, cp host<->box, gh PR writes, checkpoint) for this box without an interactive prompt. Off by default; intended for unattended orchestration of trusted boxes. Each auto-approval is recorded as a relay event (visible in `agentbox agent` / the dashboard).',
  },
  {
    key: 'box.autoApproveSafeHostActions',
    type: 'bool',
    description:
      'Auto-approve the SAFE subset of host actions without a prompt: opening a PR, PR/review comments, re-running CI, pushing to the box\'s scratch or host-sanctioned branch, checkpoints, integration writes, and file copy/download that stays inside the box project folder (non-secret). Uncontained or secret file transfers, non-sanctioned-branch pushes, and PR merge/checkout still prompt. On by default; set false to prompt for every host action (the pre-relax behavior). Superseded by box.autoApproveHostActions, which approves everything. Each auto-approval is recorded as a relay event.',
  },
  {
    key: 'box.isolateClaudeConfig',
    type: 'bool',
    description: 'Use a per-box ~/.claude volume instead of the shared one.',
  },
  {
    key: 'box.isolateCodexConfig',
    type: 'bool',
    description: 'Use a per-box ~/.codex volume instead of the shared one.',
  },
  {
    key: 'box.isolateOpencodeConfig',
    type: 'bool',
    description: 'Use a per-box OpenCode config/data volume instead of the shared one.',
  },
  {
    key: 'box.image',
    type: 'string',
    description: 'Generic box image ref (fallback). Used as fallback when no per-provider override is set; the default `agentbox/box:dev` is treated as a sentinel by cloud backends (boot from their prepared base snapshot instead).',
    advanced: true,
  },
  ...perProviderImageKeys(),
  {
    key: 'box.imageRegistry',
    type: 'string',
    description:
      'Registry repo to pull the prebuilt docker base image from before building locally. Empty = always build. Docker only (advanced).',
    advanced: true,
  },
  {
    key: 'box.dockerCacheShared',
    type: 'bool',
    description:
      "Share the in-box docker image cache across boxes via the 'agentbox-docker-cache' volume (preserved on destroy/prune; only one box can run at a time when set).",
  },
  {
    key: 'box.memory',
    type: 'int',
    description:
      'Hard memory ceiling in MiB for new boxes (0 = unlimited). Use --memory on create/claude for byte/k/m/g strings.',
  },
  {
    key: 'box.cpus',
    type: 'int',
    description:
      'CPU count cap for new boxes (0 = unlimited). Whole cores via config; use --cpus for fractional (e.g. 1.5).',
  },
  {
    key: 'box.pidsLimit',
    type: 'int',
    description: 'Max process count (PIDs cgroup) for new boxes (0 = unlimited).',
  },
  {
    key: 'box.disk',
    type: 'string',
    description:
      "Best-effort writable-layer size for new boxes, e.g. '10G'. No-op on overlay2 / the macOS engines.",
    advanced: true,
  },
  {
    key: 'box.bundleDepth',
    type: 'int',
    description:
      'Cap git bundle history shipped to cloud sandboxes (daytona, hetzner). 0 = full history. Unset = adaptive default (last 200 commits; re-bundle at 100 if the bundle exceeds 20 MB). Ignored for docker (which bind-mounts .git/).',
  },
  {
    key: 'box.daytonaClass',
    type: 'string',
    description:
      'Daytona sandbox class for new --provider daytona boxes: `linux-vm` (default) or `container`. `linux-vm` gives real pause/resume (CPU + memory frozen, running processes survive) and a much faster base bake, but runs only in `us-east-1` — the sole region with VM runners. Choose `container` to stay in a shared region (e.g. `eu`). Changing this needs a re-bake: `agentbox prepare --provider daytona --force`. Daytona-only.',
  },
  {
    key: 'box.daytonaRegion',
    type: 'string',
    description:
      'Daytona region new --provider daytona boxes are created in (e.g. `us`, `eu`, `us-east-1`). Empty (the default) derives it from `box.daytonaClass`: `linux-vm` implies `us-east-1`, `container` uses the account default. Only `us-east-1` has linux-vm runners, so pairing `linux-vm` with another region fails at create. Daytona-only.',
  },
  {
    key: 'box.daytonaTimeoutMs',
    type: 'int',
    description:
      'Idle timeout (ms) a new --provider daytona box is created with, after which Daytona auto-stops it. The host keepalive loop pushes this forward while the agent is working, so only genuinely idle boxes lapse. Default 1500000 (25 min). 0 disables auto-stop entirely. Unlike vercel/e2b (absolute session TTLs) this is an *inactivity* window. Daytona-only.',
  },
  {
    key: 'box.daytonaVmBaseImage',
    type: 'string',
    description:
      'Registry image the daytona `linux-vm` base snapshot is baked from. Empty (the default) uses the fingerprint-tagged box image CI publishes (`ghcr.io/madarco/agentbox/box:sha-<context-sha>`). Daytona can only build a VM snapshot from a prebuilt image, never a Dockerfile, so a build context with no published image (a locally modified `Dockerfile.box`) has nothing to boot and falls back to the container class -- set this to bake a VM from your own published image instead. Must be amd64 and carry an explicit tag or digest. Daytona-only.',
  },
  {
    key: 'box.hetznerLocation',
    type: 'string',
    description:
      'Hetzner datacenter location new --provider hetzner boxes are created in (e.g. `nbg1`, `fsn1`, `hel1`, `ash`). Default `nbg1`. Overridable per-create with `--location`. Hetzner-only; ignored by other providers.',
  },
  {
    key: 'box.digitaloceanRegion',
    type: 'string',
    description:
      'DigitalOcean region new --provider digitalocean boxes are created in (e.g. `nyc3`, `nyc1`, `sfo3`, `ams3`, `fra1`). Default `nyc3`. Overridable per-create with `--location`. DigitalOcean-only; ignored by other providers.',
  },
  {
    key: 'box.digitaloceanProject',
    type: 'string',
    description:
      "DigitalOcean Project new --provider digitalocean boxes are placed in — a name or the project's UUID. Unset (the default) leaves boxes in the account's default project. Set it per repo via `agentbox.yaml`, or globally at `agentbox digitalocean login`. DigitalOcean-only; ignored by other providers.",
  },
  {
    key: 'box.remoteDockerHost',
    type: 'string',
    description:
      "Default SSH destination new --provider remote-docker boxes run their container on — an `~/.ssh/config` alias or `[user@]host[:port]`. Overridable per-create with `agentbox docker:<host> …` or `--remote-host`. SSH auth comes entirely from your own `~/.ssh/config` + agent. remote-docker-only; ignored by other providers.",
  },
  {
    key: 'box.vercelTimeoutMs',
    type: 'int',
    description:
      'Max session length (ms) for new --provider vercel boxes before the VM auto-snapshots; persistent mode auto-resumes on the next call. Default 2700000 (45 min, the Hobby ceiling). Vercel-only.',
  },
  {
    key: 'box.e2bTimeoutMs',
    type: 'int',
    description:
      'Session timeout (ms) a new --provider e2b box is created with, before E2B auto-pauses it on inactivity. The host keepalive loop pushes this forward while the agent is working. Default 2700000 (45 min); the Hobby tier caps total session at ~1 h regardless. E2B-only.',
  },
  {
    key: 'box.cpMaxBytes',
    type: 'int',
    description:
      'Max bytes a single host→box copy may transfer after excludes, shared by `agentbox cp` (blocked with a size breakdown unless --yes) and each `carry:` entry (rejected at resolve time). Default 104857600 (100 MiB).',
    advanced: true,
  },
  {
    key: 'box.credentialSync',
    type: 'bool',
    description:
      'Automatically sync refreshed agent credentials (claude/codex/opencode) from boxes to the host backup and out to all other running boxes. Claude OAuth refresh rotates the refresh token, so without this every other copy 401s after any box refreshes. Default true; --no-credential-sync at create disables the in-box watcher for that box.',
  },
  {
    key: 'box.inbound',
    type: 'string',
    description:
      "Inbound-access policy for VPS boxes (hetzner, digitalocean per-box firewall). `locked` (default) = SSH reachable only from your host's egress IP; `open` = SSH reachable from anywhere (0.0.0.0/0, key-only — to drive a box from a phone with the laptop off); a CIDR list (e.g. `203.0.113.5/32`) = host egress plus those. Override per box with `--inbound` or after create with `agentbox inbound <box>`. Ignored by non-VPS providers.",
  },
  {
    key: 'box.vercelNetworkPolicy',
    type: 'string',
    description:
      "Egress lock for new --provider vercel boxes: 'allow-all' (default, unset), 'deny-all', or a comma-separated domain allowlist (e.g. 'github.com,*.npmjs.org') that denies everything else. Vercel-only; ignored by other providers.",
  },
  {
    key: 'claude.sessionName',
    type: 'string',
    description: 'tmux session name for `agentbox claude`.',
  },
  {
    key: 'claude.dangerouslySkipPermissions',
    type: 'bool',
    description:
      'Launch claude in new boxes with --dangerously-skip-permissions (auto-accept tool use). Safe because boxes are isolated; on by default. Override per-box with --no-dangerously-skip-permissions.',
  },
  {
    key: 'codex.sessionName',
    type: 'string',
    description: 'tmux session name for `agentbox codex`.',
  },
  {
    key: 'codex.dangerouslySkipPermissions',
    type: 'bool',
    description:
      'Launch codex in new boxes with --dangerously-bypass-approvals-and-sandbox (never prompt for approval). Safe because boxes are isolated; on by default. Override per-box with --no-dangerously-skip-permissions.',
  },
  {
    key: 'opencode.sessionName',
    type: 'string',
    description: 'tmux session name for `agentbox opencode`.',
  },
  {
    key: 'attach.openIn',
    type: 'enum',
    enumValues: ['split', 'window', 'tab', 'same'] as const,
    description:
      'Where `agentbox claude|codex|opencode` opens the attached session when run from tmux, cmux, Herdr, or iTerm2: `split` (tmux split-window / cmux new-split / Herdr pane.split / iTerm2 vertical split, default — same workspace), `window` (tmux new-window / cmux new-workspace / Herdr workspace.create / new iTerm2 window), `tab` (tmux new-window / cmux new-surface / Herdr tab.create in the current workspace / new iTerm2 tab), or `same` (attach inline in the current terminal). Outside tmux/cmux/Herdr/iTerm2 every value behaves like `same`.',
  },
  {
    key: 'attach.cmuxStatus',
    type: 'bool',
    description:
      "When attached inside cmux, reflect the box agent's live activity on its cmux workspace (colour + description: blue=working, amber=needs input, idle clears; restored on detach) and, when the agent needs input, flag the box's own tab via a cmux notification (tab badge + reorder + desktop notification) so it stands out among sibling tabs. cmux only; no-op in other terminals.",
  },
  {
    key: 'attach.herdrStatus',
    type: 'bool',
    description:
      "When attached inside Herdr, report the box agent's live activity to its Herdr pane (pane.report_agent: working / blocked / idle) so it looks like a normal agent pane and Herdr handles needs-input natively, and fire a Herdr notification for AgentBox's own host-relay approval prompts (git push / PR / checkpoint …) which Herdr can't otherwise see. Herdr only; no-op in other terminals.",
  },
  {
    key: 'code.ide',
    type: 'enum',
    enumValues: ['vscode', 'cursor', 'auto'] as const,
    description: 'Which IDE `agentbox code` launches; "auto" prefers code, falls back to cursor.',
  },
  {
    key: 'code.wait',
    type: 'bool',
    description: 'Block on agentbox-ctl wait-ready before opening the IDE.',
  },
  {
    key: 'code.timeoutMs',
    type: 'int',
    description: 'wait-ready timeout in milliseconds.',
  },
  {
    key: 'code.autoTerminals',
    type: 'bool',
    description: 'Generate /workspace/.vscode/tasks.json so the IDE auto-opens log panels.',
  },
  {
    key: 'shell.user',
    type: 'string',
    description: 'Default in-container user for `agentbox shell`.',
  },
  {
    key: 'shell.login',
    type: 'bool',
    description: 'Pass `-l` to bash so the login profile loads.',
  },
  {
    key: 'shell.tmux',
    type: 'bool',
    description: 'Run `agentbox shell` inside a detachable tmux session (Ctrl+a d to detach).',
  },
  {
    key: 'ssh.autoConfig',
    type: 'bool',
    description:
      'Automatically write a `~/.agentbox/ssh/config` entry (Include\'d from `~/.ssh/config`) for SSH-capable cloud boxes on create and start/resume, so `ssh <box>` just works. On by default; set false if you manage `~/.ssh/config` yourself. Explicit `agentbox shell --ssh-config`/`code`/`open` still write on demand regardless.',
  },
  {
    key: 'engine.kind',
    type: 'enum',
    enumValues: ['orbstack', 'docker-desktop', 'other', 'auto'] as const,
    description: 'Override the docker-engine auto-detection (used for OrbStack-only optimisations).',
  },
  {
    key: 'browser.default',
    type: 'enum',
    enumValues: ['agent-browser', 'playwright', 'both'] as const,
    description: 'Default browser stack inside the box. "playwright" or "both" implies box.withPlaywright.',
  },
  {
    key: 'relay.port',
    type: 'int',
    description: 'Host relay TCP port (advanced).',
    advanced: true,
  },
  {
    key: 'relay.controlPlaneUrl',
    type: 'string',
    description:
      'Public HTTPS URL of a deployed control plane (hosted Next.js + Postgres app). When set, new cloud boxes point at it for git-token leasing, permission state, and the box registry/events, and push to GitHub directly with a leased token so they keep working with the laptop off. Set via `agentbox hub set-url`.',
  },
  {
    key: 'relay.custodyMaxBodyBytes',
    type: 'int',
    description:
      "Per-request body cap (bytes) for custody PUTs (default 33554432 = 32 MiB). Custody carries a project's untracked-files seed tar, which the relay's 1 MiB control-plane body cap is too small for; this cap applies only to custody, so every other relay route keeps the smaller one. On a PC it governs how large a seed blob the client will upload; a control box enforces its own cap via AGENTBOX_CUSTODY_MAX_BODY_BYTES, so raise both to admit a bigger seed (a blob the control box refuses is dropped and the rest of the seed still pushes).",
    advanced: true,
  },
  {
    key: 'git.pushMode',
    type: 'enum',
    enumValues: ['auto', 'relay', 'lease', 'direct'] as const,
    description:
      "How a box's `git push` reaches GitHub: `relay` (the host relay pushes with your host credentials — they never enter the box), `lease` (the relay/plane leases a short-lived GitHub-App token and the box pushes directly, so it works with the laptop off), `direct` (the box holds a COPY of your git credentials and pushes/pulls/signs entirely on its own — needs no host or hub, but the credentials live inside the box and its snapshots; set via `--with-credentials`, which copies them in behind a confirmation), or `auto` (default — lease when `relay.controlPlaneUrl` is set for the box, else relay). Only affects cloud boxes; docker boxes always use `relay`. Forcing `relay` needs a reachable host relay for the box; forcing `lease` needs a reachable relay/plane with a GitHub App; `direct` needs credentials to have been copied into the box at create time.",
  },
  {
    key: 'vnc.containerPort',
    type: 'int',
    description: 'Container-side noVNC port (advanced).',
    advanced: true,
  },
  {
    key: 'portless.enabled',
    type: 'bool',
    description:
      'Map each box web app to a https://<box-name>.localhost URL via the Portless proxy (Docker Desktop only; OrbStack already has .orb.local). Default: prompt.',
  },
  {
    key: 'portless.stateDir',
    type: 'string',
    description:
      'Host Portless state directory to share into boxes (advanced; default: Portless’s own location).',
    advanced: true,
  },
  {
    key: 'autopause.enabled',
    type: 'bool',
    description:
      'Let the host relay periodically pause idle boxes when more than autopause.maxRunningBoxes are running.',
  },
  {
    key: 'autopause.maxRunningBoxes',
    type: 'int',
    description:
      'Target maximum number of simultaneously-running boxes before idle ones get auto-paused.',
  },
  {
    key: 'autopause.idleMinutes',
    type: 'int',
    description:
      'Minutes a box must be continuously idle (claude state) before it is eligible for auto-pause.',
  },
  {
    key: 'queue.enabled',
    type: 'bool',
    description:
      'Run `agentbox claude|codex|opencode -i <prompt>` jobs through the host-wide background queue (FIFO, capped by queue.maxConcurrent).',
  },
  {
    key: 'queue.maxConcurrent',
    type: 'int',
    description:
      'Max number of simultaneously-running boxes (across providers) before background `-i` jobs queue up instead of starting immediately. Per-invocation override: `--max-running <n>`.',
  },
  {
    key: 'queue.maxWorking',
    type: 'int',
    description:
      'Max agents actively working/thinking (quota-consuming) at once before background `-i` jobs queue. 0 = disabled (use the queue.maxConcurrent running-box gate). Counts all boxes, foreground + queued. Per-invocation override: `--max-working <n>`.',
  },
  {
    key: 'queue.idleGraceSeconds',
    type: 'int',
    description:
      'Seconds an agent must stay non-working before it frees its working slot (debounce against brief idle flaps between turns). Only used when queue.maxWorking > 0.',
  },
  {
    key: 'queue.openIn',
    type: 'enum',
    enumValues: ['none', 'split', 'window', 'tab'] as const,
    description:
      'When a background `-i` job finishes creating its box, where the host relay opens an attached terminal onto it: `none` (default — open nothing, just queue), `split`, `window`, or `tab`. Honored only when the submitting shell runs inside tmux, cmux, Herdr, or iTerm2 (the targeting is captured at submit time). Under cmux, `split` splits the pane you submitted from (falling back to the parent workspace, then a new workspace), `tab` adds a tab in the parent workspace, and `window` opens a separate workspace; under Herdr, `split` splits the pane you submitted from, `tab` adds a tab in the parent workspace, and `window` opens a separate workspace; iTerm2 opens relative to the frontmost window. Unlike `attach.openIn` there is no `same` mode — the box is created asynchronously, so it is always a fresh terminal.',
  },
  {
    key: 'cloud.useCurrentBranch',
    type: 'bool',
    description:
      "On cloud providers (daytona/hetzner), start new boxes on the host's current branch instead of forking a new agentbox/<box-name> branch. Overridden by an explicit --use-branch / --from-branch.",
  },
  {
    key: 'cloud.viaHub',
    type: 'bool',
    description:
      'When a control box is configured (relay.controlPlaneUrl), create cloud boxes ON the control box by default instead of on this machine (so they keep running with the laptop off). On by default; set false to always build cloud boxes locally. Overridden per-command by --via-hub / --local. Docker and remote-docker always build locally regardless.',
  },
  {
    key: 'maintenance.pruneProjectConfigs',
    type: 'bool',
    description:
      'Periodically delete ~/.agentbox/projects/<hash>/ dirs whose source workspace folder no longer exists.',
  },
  {
    key: 'maintenance.pruneProjectConfigsEvery',
    type: 'int',
    description: 'Run the orphan project-config sweep every N successful `agentbox create`.',
  },
  {
    key: 'update.check',
    type: 'bool',
    description:
      'Daily background check for a newer published agentbox (npm registry) and menu-bar app (release sha sidecar), plus the "newer version available" nudge. At most one network probe per 24h; false disables both.',
  },
  {
    key: 'integrations.notion.enabled',
    type: 'bool',
    description:
      'Enable the in-box Notion integration shim (`ntn`/`notion` commands routed via the host relay). When false (default), the relay refuses dispatch with a clear "disabled" error and no host process is touched.',
  },
  {
    key: 'integrations.linear.enabled',
    type: 'bool',
    description:
      'Enable the in-box Linear integration shim (`linear` commands routed via the host relay; backed by `@schpet/linear-cli`). When false (default), the relay refuses dispatch with a clear "disabled" error and no host process is touched.',
  },
];

const REGISTRY_BY_KEY = new Map<string, KeyDescriptor>(KEY_REGISTRY.map((d) => [d.key, d]));

export function lookupKey(key: string): KeyDescriptor | undefined {
  return REGISTRY_BY_KEY.get(key);
}

export class UserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserConfigError';
  }
}

export type ConfigScope = 'global' | 'project';
