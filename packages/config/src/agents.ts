/**
 * The agents this build knows about, as far as CONFIG is concerned.
 *
 * WHY A TABLE HERE RATHER THAN AN IMPORT. `@agentbox/config` has no internal
 * dependencies — every package depends on it, never the reverse — so it cannot
 * read the agent registry to learn what exists. This is the same arrangement
 * `providers.ts` uses for `PROVIDERS`: the identity is declared here as data,
 * the behavior lives in the package, and the two are tied together only by the
 * `id` string.
 *
 * Copied rather than imported means it can drift, so it is drift-tested from a
 * package that can see both (`apps/cli`, which reaches the registry and this
 * table) — exactly where `provider-descriptors.test.ts` lives and for the same
 * reason.
 *
 * Keep this MINIMAL. It is not a second registry: it holds only what generating
 * config keys needs. Anything else about an agent belongs on its spec row.
 */

/** What config needs to know to generate one agent's keys. */
export interface AgentConfigKind {
  /** Canonical agent id — must match the registry row's `id`. */
  readonly id: string;
  /** Default tmux session name, the generated `<id>.sessionName` default. */
  readonly defaultSessionName: string;
  /**
   * Whether this agent has a "never prompt me" launch flag.
   *
   * Not universal: OpenCode has none, which is why generating
   * `<id>.dangerouslySkipPermissions` for every agent would create a key that
   * silently does nothing. The flag itself lives on the agent, not here.
   */
  readonly hasSkipPermissions: boolean;
  /** Description for the generated `<id>.dangerouslySkipPermissions` key. */
  readonly skipPermissionsDesc?: string;
  /**
   * Description for the generated `box.isolate<Id>Config` key. Defaults to
   * naming `~/.<id>`, which is right for every agent whose config is a single
   * dotfolder — OpenCode's is not, hence the override.
   */
  readonly isolateVolumeDesc?: string;
  /**
   * Settings this agent declares for itself, mirroring
   * `AgentSyncSpec.settings`. Each generates a `<id>.<key>` config key.
   *
   * Mirrored rather than imported for the reason this whole table exists, and
   * drift-tested from `apps/cli` against the registry. An agent installed from
   * an npm package contributes its settings at runtime instead — see
   * `agent-plugins.ts` — so this array only ever covers the built-ins.
   */
  readonly settings?: readonly AgentConfigSetting[];
}

/**
 * One declared agent setting, as far as CONFIG is concerned. The registry's
 * `AgentSettingSpec` carries one more field (`affectsBake`) that only the
 * fingerprint fold cares about; everything here is what generating a key needs.
 */
export interface AgentConfigSetting {
  readonly key: string;
  readonly type: 'string' | 'bool' | 'enum';
  readonly enumValues?: readonly string[];
  readonly default: string | boolean;
  readonly description: string;
  readonly advanced?: boolean;
}

export const AGENT_KINDS = [
  {
    id: 'claude',
    defaultSessionName: 'claude',
    hasSkipPermissions: true,
    skipPermissionsDesc:
      'Launch claude in new boxes with --dangerously-skip-permissions (auto-accept tool use). On by default: a box is already an isolated sandbox, so the prompt only slows the agent down. Set false to be asked.',
    settings: [
      {
        key: 'install',
        type: 'enum',
        enumValues: ['native', 'npm'],
        default: 'native',
        description:
          "How Claude Code is installed into a box image: `native` runs Anthropic's installer (the recommended path), `npm` installs @anthropic-ai/claude-code. Use `npm` on hosts whose egress IP the native CDN 403s. Bake-time - changing it re-derives the agent layer.",
      },
      {
        key: 'tui',
        type: 'enum',
        enumValues: ['default', 'fullscreen', 'auto'],
        default: 'default',
        description:
          "Terminal renderer Claude Code uses inside a box. Claude's `fullscreen` renderer repaints differentially and leaves stale characters in the blank areas of the screen over a network transport - visible while scrolling, cleared only by resizing the terminal. Boxes pin the classic renderer; set `fullscreen` to opt back in, or `auto` to let Claude decide. Rides the launch, so it takes effect on the agent's next start.",
      },
    ],
  },
  {
    id: 'codex',
    defaultSessionName: 'codex',
    hasSkipPermissions: true,
    skipPermissionsDesc:
      'Launch codex in new boxes with --dangerously-bypass-approvals-and-sandbox (auto-accept tool use). On by default for the same reason as claude; set false to be asked.',
  },
  {
    id: 'opencode',
    defaultSessionName: 'opencode',
    hasSkipPermissions: false,
    isolateVolumeDesc: 'Use a per-box OpenCode config/data volume instead of the shared one.',
  },
  {
    id: 'pi',
    defaultSessionName: 'pi',
    // Pi has no permission prompts AT ALL -- by design it runs with full
    // permissions and its own docs recommend a container -- so there is no
    // bypass flag, and generating the key would create one that does nothing.
    hasSkipPermissions: false,
    isolateVolumeDesc:
      'Use a per-box Pi config/data volume (~/.pi/agent) instead of the shared one.',
  },
  // The hidden demo agent (see `@agentbox/agent-example`). Present so the
  // generated keys cover it too — an agent absent from this table would be the
  // one thing still needing a hand edit.
  { id: 'example', defaultSessionName: 'example', hasSkipPermissions: false },
] as const satisfies readonly AgentConfigKind[];

/** Every agent id config knows about. */
export const AGENT_KIND_NAMES: readonly string[] = AGENT_KINDS.map((a) => a.id);

/** True for an agent this build's config knows about. */
export function isAgentConfigKind(name: string): boolean {
  return AGENT_KIND_NAMES.includes(name);
}
