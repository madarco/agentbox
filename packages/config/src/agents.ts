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
}

export const AGENT_KINDS = [
  {
    id: 'claude',
    defaultSessionName: 'claude',
    hasSkipPermissions: true,
    skipPermissionsDesc:
      'Launch claude in new boxes with --dangerously-skip-permissions (auto-accept tool use). On by default: a box is already an isolated sandbox, so the prompt only slows the agent down. Set false to be asked.',
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
