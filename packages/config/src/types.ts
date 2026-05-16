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

export interface UserConfig {
  box?: {
    snapshot?: boolean;
    withPlaywright?: boolean;
    vnc?: boolean;
    isolateClaudeConfig?: boolean;
    image?: string;
    dockerCacheShared?: boolean;
  };
  claude?: {
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
 * `box.snapshot` is intentionally `boolean | undefined` (unprompted): the
 * default is "ask the user", expressed as undefined.
 */
export interface EffectiveConfig {
  box: {
    snapshot: boolean | undefined;
    withPlaywright: boolean;
    vnc: boolean;
    isolateClaudeConfig: boolean;
    image: string;
    dockerCacheShared: boolean;
  };
  claude: {
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
  /** Per-leaf source map: 'box.snapshot' -> 'workspace'. Powers `config get --all`. */
  sources: Record<string, ConfigSource>;
  /** Resolved project root used for the project layer (cwd if no agentbox.yaml found). */
  projectRoot: string;
  projectHash: string;
  /** True if we walked up to an agentbox.yaml; false if we fell back to cwd. */
  hasAgentboxYaml: boolean;
}

export const BUILT_IN_DEFAULTS: EffectiveConfig = {
  box: {
    snapshot: undefined,
    withPlaywright: false,
    vnc: true,
    isolateClaudeConfig: false,
    image: 'agentbox/box:dev',
    dockerCacheShared: false,
  },
  claude: {
    sessionName: 'claude',
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
    key: 'box.snapshot',
    type: 'bool',
    description: 'Use a frozen APFS clone of the workspace as the overlay lower (default: prompt).',
  },
  {
    key: 'box.withPlaywright',
    type: 'bool',
    description: 'Install @playwright/cli@latest in the box at create time.',
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
    key: 'claude.sessionName',
    type: 'string',
    description: 'tmux session name for `agentbox claude`.',
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
