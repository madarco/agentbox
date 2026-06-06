/**
 * Layered user config. The same shape is accepted at three layers:
 *   - global   ~/.agentbox/config.yaml
 *   - project  ~/.agentbox/projects/<hash>/config.yaml
 *   - workspace  defaults: block in ./agentbox.yaml
 *
 * Plus a CLI-flag layer at runtime. Precedence (highest wins):
 *   cli > workspace > project > global > built-in defaults.
 */

export type IdeFlavor = 'vscode' | 'cursor' | 'auto';
export type EngineKind = 'orbstack' | 'docker-desktop' | 'other' | 'auto';
export type BrowserKind = 'agent-browser' | 'playwright' | 'both';
/** Sandbox backend new boxes are created on. */
export type ProviderKind = 'docker' | 'daytona' | 'hetzner' | 'vercel' | 'e2b';
/** Where `agentbox claude|codex|opencode` opens the attached session when the host
 *  shell is running inside tmux, cmux, or iTerm2. `same` keeps today's inline behavior. */
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
    /**
     * Generic VM-size fallback for cloud providers. Provider-interpreted:
     * Hetzner = server type string (e.g. `cx33`); Daytona = `cpu-memory-disk`
     * GB spec (e.g. `4-8-20`). Per-provider `size{Provider}` wins over this.
     * Docker/Vercel ignore it (Docker uses `memory`/`cpus`/`disk`; Vercel uses
     * `vercelVcpus`).
     */
    size?: string;
    sizeDocker?: string;
    sizeDaytona?: string;
    sizeHetzner?: string;
    sizeVercel?: string;
    sizeE2b?: string;
    withPlaywright?: boolean;
    withEnv?: boolean;
    resyncOnStart?: boolean;
    vnc?: boolean;
    autoApproveHostActions?: boolean;
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
    imageRegistry?: string;
    dockerCacheShared?: boolean;
    memory?: number;
    cpus?: number;
    pidsLimit?: number;
    disk?: string;
    bundleDepth?: number;
    vercelVcpus?: number;
    vercelTimeoutMs?: number;
    vercelNetworkPolicy?: string;
    cpMaxBytes?: number;
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
  engine?: {
    kind?: EngineKind;
  };
  browser?: {
    default?: BrowserKind;
  };
  relay?: {
    port?: number;
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
  };
  maintenance?: {
    pruneProjectConfigs?: boolean;
    pruneProjectConfigsEvery?: number;
  };
  integrations?: {
    notion?: {
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
    size: string;
    sizeDocker: string;
    sizeDaytona: string;
    sizeHetzner: string;
    sizeVercel: string;
    sizeE2b: string;
    withPlaywright: boolean;
    withEnv: boolean;
    resyncOnStart: boolean;
    vnc: boolean;
    autoApproveHostActions: boolean;
    isolateClaudeConfig: boolean;
    isolateCodexConfig: boolean;
    isolateOpencodeConfig: boolean;
    image: string;
    imageDocker: string;
    imageDaytona: string;
    imageHetzner: string;
    imageVercel: string;
    imageE2b: string;
    imageRegistry: string;
    dockerCacheShared: boolean;
    memory: number;
    cpus: number;
    pidsLimit: number;
    disk: string;
    bundleDepth: number | undefined;
    vercelVcpus: number;
    vercelTimeoutMs: number;
    vercelNetworkPolicy: string;
    cpMaxBytes: number;
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
  engine: {
    kind: EngineKind;
  };
  browser: {
    default: BrowserKind;
  };
  relay: {
    port: number;
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
  };
  maintenance: {
    pruneProjectConfigs: boolean;
    pruneProjectConfigsEvery: number;
  };
  integrations: {
    notion: {
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
    size: '',
    sizeDocker: '',
    sizeDaytona: '',
    sizeHetzner: '',
    sizeVercel: '',
    sizeE2b: '',
    withPlaywright: false,
    withEnv: false,
    resyncOnStart: true,
    vnc: true,
    autoApproveHostActions: false,
    isolateClaudeConfig: false,
    isolateCodexConfig: false,
    isolateOpencodeConfig: false,
    image: 'agentbox/box:dev',
    imageDocker: '',
    imageDaytona: '',
    imageHetzner: '',
    imageVercel: '',
    imageE2b: '',
    // Mirrors BOX_IMAGE_REGISTRY in @agentbox/sandbox-docker. Empty disables the
    // registry pull (always build the docker base image locally).
    imageRegistry: 'ghcr.io/madarco/agentbox/box',
    dockerCacheShared: false,
    memory: 0,
    cpus: 0,
    pidsLimit: 0,
    disk: '',
    bundleDepth: undefined,
    vercelVcpus: 2,
    vercelTimeoutMs: 2_700_000,
    vercelNetworkPolicy: '',
    cpMaxBytes: 100 * 1024 * 1024,
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
  engine: {
    kind: 'auto',
  },
  browser: {
    default: 'agent-browser',
  },
  relay: {
    port: 8787,
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
  },
  maintenance: {
    pruneProjectConfigs: true,
    pruneProjectConfigsEvery: 50,
  },
  integrations: {
    notion: { enabled: false },
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

/**
 * Single source of truth for which keys are addressable from the CLI. The
 * parser, `set`/`unset`, and `list` all walk this. Adding a key here is the
 * one place a new field has to be registered (plus the type interface above
 * and the JSON schema).
 */
export const KEY_REGISTRY: readonly KeyDescriptor[] = [
  {
    key: 'box.provider',
    type: 'enum',
    enumValues: ['docker', 'daytona', 'hetzner', 'vercel', 'e2b'] as const,
    description:
      'Sandbox backend new boxes are created on: local Docker containers, Daytona Cloud sandboxes, Hetzner Cloud VPSes, Vercel Sandboxes, or E2B microVMs.',
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
  {
    key: 'box.defaultCheckpointDocker',
    type: 'string',
    description:
      'Per-provider override of `box.defaultCheckpoint` for docker. Wins over the global when set; set via `agentbox checkpoint set-default --provider docker`.',
    advanced: true,
  },
  {
    key: 'box.defaultCheckpointDaytona',
    type: 'string',
    description:
      'Per-provider override of `box.defaultCheckpoint` for daytona. Wins over the global when set; set via `agentbox checkpoint set-default --provider daytona`.',
    advanced: true,
  },
  {
    key: 'box.defaultCheckpointHetzner',
    type: 'string',
    description:
      'Per-provider override of `box.defaultCheckpoint` for hetzner. Wins over the global when set; set via `agentbox checkpoint set-default --provider hetzner`.',
    advanced: true,
  },
  {
    key: 'box.defaultCheckpointVercel',
    type: 'string',
    description:
      'Per-provider override of `box.defaultCheckpoint` for vercel. Wins over the global when set; set via `agentbox checkpoint set-default --provider vercel`.',
    advanced: true,
  },
  {
    key: 'box.defaultCheckpointE2b',
    type: 'string',
    description:
      'Per-provider override of `box.defaultCheckpoint` for e2b. Wins over the global when set; set via `agentbox checkpoint set-default --provider e2b`.',
    advanced: true,
  },
  {
    key: 'box.size',
    type: 'string',
    description:
      'Default VM size for cloud providers. Provider-interpreted: hetzner = server type (e.g. `cx33`); daytona = `cpu-memory-disk` GB (e.g. `4-8-20`). Used as fallback when no per-provider override is set. Docker/Vercel ignore it.',
  },
  {
    key: 'box.sizeDocker',
    type: 'string',
    description:
      'Per-provider override of `box.size` for docker. Reserved — docker sizing is controlled via `box.memory` / `box.cpus` / `box.disk`.',
    advanced: true,
  },
  {
    key: 'box.sizeDaytona',
    type: 'string',
    description:
      'Per-provider override of `box.size` for daytona. `cpu-memory-disk` GB spec (e.g. `4-8-20`). Only honored on the image/Dockerfile create path; Daytona rejects custom resources on snapshot-resume.',
    advanced: true,
  },
  {
    key: 'box.sizeHetzner',
    type: 'string',
    description:
      'Per-provider override of `box.size` for hetzner. Server type string (e.g. `cx23`, `cx33`, `cx43`).',
    advanced: true,
  },
  {
    key: 'box.sizeVercel',
    type: 'string',
    description:
      'Per-provider override of `box.size` for vercel. Reserved — vercel sizing is controlled via `box.vercelVcpus`.',
    advanced: true,
  },
  {
    key: 'box.sizeE2b',
    type: 'string',
    description:
      'Per-provider override of `box.size` for e2b. Reserved — e2b sizing is template-level (set at `agentbox prepare --provider e2b` time via --vcpus / --memory).',
    advanced: true,
  },
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
  {
    key: 'box.imageDocker',
    type: 'string',
    description: 'Per-provider override of `box.image` for docker (local docker image ref, e.g. `agentbox/box:dev`). Wins over the generic when set.',
    advanced: true,
  },
  {
    key: 'box.imageDaytona',
    type: 'string',
    description: 'Per-provider override of `box.image` for daytona (named snapshot, e.g. `agentbox-base-<fingerprint>`). Written by `agentbox prepare --provider daytona`.',
    advanced: true,
  },
  {
    key: 'box.imageHetzner',
    type: 'string',
    description: 'Per-provider override of `box.image` for hetzner (image description, e.g. `agentbox-base-<fingerprint>`). Written by `agentbox prepare --provider hetzner`.',
    advanced: true,
  },
  {
    key: 'box.imageVercel',
    type: 'string',
    description: 'Per-provider override of `box.image` for vercel (snapshot id, e.g. `snap_…`). Written by `agentbox prepare --provider vercel`.',
    advanced: true,
  },
  {
    key: 'box.imageE2b',
    type: 'string',
    description: 'Per-provider override of `box.image` for e2b (template id or `name:tag`, e.g. `agentbox-base:latest`). Written by `agentbox prepare --provider e2b`.',
    advanced: true,
  },
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
    key: 'box.vercelVcpus',
    type: 'int',
    description:
      'vCPUs for new --provider vercel boxes (Vercel couples RAM at 2048 MB/vCPU). Default 2. Vercel only accepts specific counts (e.g. 1, 2, 4, 8) — an unsupported value fails create with a 400. Vercel-only; ignored by other providers.',
  },
  {
    key: 'box.vercelTimeoutMs',
    type: 'int',
    description:
      'Max session length (ms) for new --provider vercel boxes before the VM auto-snapshots; persistent mode auto-resumes on the next call. Default 2700000 (45 min, the Hobby ceiling). Vercel-only.',
  },
  {
    key: 'box.cpMaxBytes',
    type: 'int',
    description:
      'Max bytes a single host→box copy may transfer after excludes, shared by `agentbox cp` (blocked with a size breakdown unless --yes) and each `carry:` entry (rejected at resolve time). Default 104857600 (100 MiB).',
    advanced: true,
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
      'Where `agentbox claude|codex|opencode` opens the attached session when run from tmux, cmux, or iTerm2: `split` (tmux split-window / cmux new-split / iTerm2 vertical split, default — same workspace), `window` (tmux new-window / cmux new-workspace / new iTerm2 window), `tab` (tmux new-window / cmux new-surface tab in the current pane, same workspace / new iTerm2 tab), or `same` (attach inline in the current terminal). Outside tmux/cmux/iTerm2 every value behaves like `same`.',
  },
  {
    key: 'attach.cmuxStatus',
    type: 'bool',
    description:
      "When attached inside cmux, reflect the box agent's live activity on its cmux workspace (colour + description: blue=working, amber=needs input, idle clears; restored on detach) and, when the agent needs input, flag the box's own tab via a cmux notification (tab badge + reorder + desktop notification) so it stands out among sibling tabs. cmux only; no-op in other terminals.",
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
      'When a background `-i` job finishes creating its box, where the host relay opens an attached terminal onto it: `none` (default — open nothing, just queue), `split`, `window`, or `tab`. Honored only when the submitting shell runs inside tmux, cmux, or iTerm2 (the targeting is captured at submit time). Under cmux, `split` splits the pane you submitted from (falling back to the parent workspace, then a new workspace), `tab` adds a tab in the parent workspace, and `window` opens a separate workspace; iTerm2 opens relative to the frontmost window. Unlike `attach.openIn` there is no `same` mode — the box is created asynchronously, so it is always a fresh terminal.',
  },
  {
    key: 'cloud.useCurrentBranch',
    type: 'bool',
    description:
      "On cloud providers (daytona/hetzner), start new boxes on the host's current branch instead of forking a new agentbox/<box-name> branch. Overridden by an explicit --use-branch / --from-branch.",
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
    key: 'integrations.notion.enabled',
    type: 'bool',
    description:
      'Enable the in-box Notion integration shim (`ntn`/`notion` commands routed via the host relay). When false (default), the relay refuses dispatch with a clear "disabled" error and no host process is touched.',
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
