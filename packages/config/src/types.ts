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
export type ProviderKind = 'docker' | 'daytona';

export interface UserConfig {
  box?: {
    provider?: ProviderKind;
    hostSnapshot?: boolean;
    defaultCheckpoint?: string;
    withPlaywright?: boolean;
    withEnv?: boolean;
    vnc?: boolean;
    isolateClaudeConfig?: boolean;
    isolateCodexConfig?: boolean;
    isolateOpencodeConfig?: boolean;
    image?: string;
    dockerCacheShared?: boolean;
    memory?: number;
    cpus?: number;
    pidsLimit?: number;
    disk?: string;
  };
  checkpoint?: {
    maxLayers?: number;
  };
  claude?: {
    sessionName?: string;
  };
  codex?: {
    sessionName?: string;
  };
  opencode?: {
    sessionName?: string;
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
  maintenance?: {
    pruneProjectConfigs?: boolean;
    pruneProjectConfigsEvery?: number;
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
    withPlaywright: boolean;
    withEnv: boolean;
    vnc: boolean;
    isolateClaudeConfig: boolean;
    isolateCodexConfig: boolean;
    isolateOpencodeConfig: boolean;
    image: string;
    dockerCacheShared: boolean;
    memory: number;
    cpus: number;
    pidsLimit: number;
    disk: string;
  };
  checkpoint: {
    maxLayers: number;
  };
  claude: {
    sessionName: string;
  };
  codex: {
    sessionName: string;
  };
  opencode: {
    sessionName: string;
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
  maintenance: {
    pruneProjectConfigs: boolean;
    pruneProjectConfigsEvery: number;
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
    withPlaywright: false,
    withEnv: false,
    vnc: true,
    isolateClaudeConfig: false,
    isolateCodexConfig: false,
    isolateOpencodeConfig: false,
    image: 'agentbox/box:dev',
    dockerCacheShared: false,
    memory: 0,
    cpus: 0,
    pidsLimit: 0,
    disk: '',
  },
  checkpoint: {
    maxLayers: 3,
  },
  claude: {
    sessionName: 'claude',
  },
  codex: {
    sessionName: 'codex',
  },
  opencode: {
    sessionName: 'opencode',
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
  maintenance: {
    pruneProjectConfigs: true,
    pruneProjectConfigsEvery: 50,
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
    enumValues: ['docker', 'daytona'] as const,
    description:
      'Sandbox backend new boxes are created on: local Docker containers or Daytona Cloud sandboxes.',
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
      'Checkpoint ref new boxes in this project start from when --snapshot is not given (set via `agentbox checkpoint set-default`).',
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
    key: 'box.vnc',
    type: 'bool',
    description: 'Run the per-box Xvnc + noVNC stack.',
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
    description: 'Box image ref (advanced).',
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
    key: 'claude.sessionName',
    type: 'string',
    description: 'tmux session name for `agentbox claude`.',
  },
  {
    key: 'codex.sessionName',
    type: 'string',
    description: 'tmux session name for `agentbox codex`.',
  },
  {
    key: 'opencode.sessionName',
    type: 'string',
    description: 'tmux session name for `agentbox opencode`.',
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
