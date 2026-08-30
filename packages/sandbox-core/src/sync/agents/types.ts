/**
 * `AgentSyncSpec` — the single source of truth for every per-tool datum the
 * sync layer needs (paths, credential locations, forwarded env keys,
 * capabilities). Generalizes the cloud `AGENT_SPECS` table
 * (`@agentbox/sandbox-cloud/agent-credentials.ts`) so the docker + cloud
 * providers, the driver, and the CLI all read one registry instead of
 * re-branching on tool name in ~10 places.
 *
 * This holds DATA only. Per-tool *behavior* that needs the host FS (static-tree
 * transforms, stage producers, box→host pull inventories) lives in
 * `@agentbox/sandbox-docker` today and migrates into `sync/agents/<tool>/` in
 * later phases; those fields are added to this spec as they move (a
 * sandbox-core registry can't reference sandbox-docker without a dependency
 * cycle).
 */

import type { AgentId } from '@agentbox/core';

/**
 * Canonical agent id. Re-exported from `@agentbox/core` rather than redeclared:
 * one open string type, one home.
 */
export type { AgentId };

/**
 * One host static-config source dir and where it lands inside the box. Most
 * tools have exactly one; OpenCode has three (data / config / state), which is
 * why this is a list — its layout becomes data instead of tool-specific control
 * flow.
 */
export interface AgentPathMap {
  /** Host source dir, as path segments relative to `os.homedir()` (e.g. `['.claude']`). */
  hostHomeRel: string[];
  /** Absolute box dir the source's static config is mounted/extracted at. */
  boxDir: string;
  /**
   * Sub-path under `boxDir` to land this source at (OpenCode: config →
   * `config`, state → `.state/opencode`). Absent ⇒ land at `boxDir` root.
   */
  relocToSubpath?: string;
  /** rsync `--update` (newest-wins) — OpenCode `model.json` is two-way state. */
  update?: boolean;
  /**
   * rsync/tar `--exclude` patterns for this source. Populated per tool as the
   * static-config concern migrates (Phase 7); OpenCode's are already exact.
   */
  exclude?: string[];
  /**
   * rsync `--include` carve-ins for this source. Consumers MUST emit these
   * before the excludes (rsync filter rules are first-match-wins) — used to
   * re-include a subtree of an otherwise-excluded dir (codex:
   * `.tmp/marketplaces/` out of the excluded `.tmp`).
   */
  include?: string[];
}

/** Where this tool's login credential lives on the box, on the host backup, and in the cloud volume. */
export interface AgentCredential {
  /** File the agent reads/writes, relative to its primary box dir. */
  boxRelPath: string;
  /** Canonical absolute in-box path (for the box→host `cat` extract). */
  boxAbsPath: string;
  /** Host backup under `~/.agentbox` that survives box destroys. */
  hostBackup: string;
  /** Cloud shared-credentials-volume mount for this agent. */
  cloudMountPath: string;
  /** Sub-dir of the shared cloud credentials volume for this agent. */
  cloudSubpath: string;
  /**
   * What a *real* (usable, non-placeholder) credential file must contain — the
   * box→host extract guard (`isRealAgentCredential`). `claude-oauth` requires a
   * non-empty `claudeAiOauth.refreshToken` (a setup-token blob has an
   * accessToken but no refreshToken and must not clobber a good backup);
   * `nonempty-json` (codex/opencode `auth.json`) just has to parse as a
   * non-empty JSON object. Encodes the per-agent switch that used to live inside
   * the docker credential helper.
   */
  realShape: 'claude-oauth' | 'nonempty-json';
}

/** Capabilities that genuinely differ per tool (drive resume/teleport/activity wiring). */
export interface AgentCapabilities {
  /** Session resume supported (`--resume`). OpenCode: false. */
  resume: boolean;
  /** Session-teleport support. OpenCode: a stub that throws. */
  teleport: 'full' | 'stub';
  /**
   * Why teleport is a stub, in the user's words. Required in spirit whenever
   * `teleport: 'stub'` — it is what the refusal actually prints.
   *
   * Data, not a thrown-from-a-module string, so declaring `teleport: 'stub'` is
   * all an agent has to do to get a good refusal: no per-agent `case` in
   * `prepareTeleport`, no module of its own. Falls back to a generic message.
   */
  teleportStubReason?: string;
  /** How in-box activity is reported. OpenCode uses a plugin, not a tmux scraper. */
  activitySource: 'scraper' | 'plugin';
}

/**
 * How to put this agent's binary into a box that doesn't have it.
 *
 * One recipe, two execution sites: the Dockerfile/provider install scripts read
 * it at BAKE time (`AGENTBOX_AGENTS`), and `ensureAgentInstalled` runs it at
 * RUN time against a live box. Keeping it as data is what lets a box carry only
 * the agent it was launched for and still gain another on demand.
 */
export type AgentInstallRecipe =
  /** `npm install -g <package>`. `allowScripts` for packages with lifecycle scripts (npm 12+ blocks them by default). */
  | { kind: 'npm'; package: string; allowScripts?: boolean }
  /** Fetch an installer to a file and run it. NOT `curl | bash` — a blocked download must fail the chain, not exit 0. */
  | { kind: 'script'; url: string; retries?: number }
  /** Anything else: a shell snippet run as-is. */
  | { kind: 'exec'; script: string };

export interface AgentInstall {
  recipe: AgentInstallRecipe;
  /**
   * Who runs the recipe. Not a detail — Claude's native installer drops the
   * binary in the INVOKING user's `~/.local/bin`, so running it as root puts
   * `claude` in /root and the box user never sees it. `npm install -g` is the
   * opposite and needs root. `apt` is always root regardless.
   */
  runAs: 'root' | 'box-user';
  /**
   * OS packages the agent needs alongside its own installer (codex: bubblewrap).
   * Installed with whichever package manager the box has -- see
   * `renderPackageInstall`; boxes are Debian/Ubuntu except Vercel (AL2023/dnf).
   */
  packages?: string[];
  /**
   * True when the agent still works without those packages, just degraded.
   * An optional prerequisite that fails logs and continues; a required one
   * aborts the install. Default (undefined) is REQUIRED, so a new prerequisite
   * has to opt into being skippable rather than silently becoming so.
   */
  packagesOptional?: boolean;
  /** Shell run after the recipe succeeds (dirs, symlinks, ownership). Runs as root. */
  postInstall?: string;
  /**
   * Alternate ways to install the same agent, keyed by mode.
   *
   * Only `npm` is used today: `box.claudeInstall: npm` is the documented escape
   * hatch for hosts whose egress IP the Claude CDN 403s. Without this the mode
   * would silently do nothing now that the install lives here rather than in a
   * Dockerfile branch.
   */
  alternates?: Record<string, Omit<AgentInstall, 'alternates'>>;
}

/** Pick the install for `mode`, falling back to the default recipe. */
export function resolveAgentInstall(
  install: AgentInstall,
  mode?: string,
): Omit<AgentInstall, 'alternates'> {
  const alt = mode ? install.alternates?.[mode] : undefined;
  return alt ?? install;
}

export interface AgentSyncSpec {
  id: AgentId;
  /** Alternate spellings that resolve to this spec (reconciles the wire `'claude-code'`). */
  aliases: string[];
  /**
   * The FROZEN wire/queue spelling, when it differs from `id` (claude only).
   * Carried here so a caller that needs the queue name doesn't re-derive it —
   * `buildPromptArgs` / `assertAgentCredsAvailable` want `'claude-code'` while
   * everything else wants `'claude'`.
   */
  wireId?: string;
  /** Default tmux session name. */
  sessionName: string;
  /** Command name to probe with `command -v` — how we tell "already installed". */
  binary: string;
  /** How to install the binary into a box that lacks it. */
  install: AgentInstall;
  /** Shared docker config volume for this tool's static config. */
  dockerVolume: string;
  /** Host→box static-config source map (1 entry for claude/codex, 3 for opencode). */
  staticPaths: AgentPathMap[];
  credential: AgentCredential;
  /** Host env keys forwarded into the box so an env-authed agent finds its creds. */
  forwardedEnvKeys: readonly string[];
  /**
   * Extra box run-env (OpenCode: `OPENCODE_CONFIG_DIR`, `XDG_STATE_HOME`).
   *
   * Plain data, not a function: the whole spec has to stay JSON-serializable so
   * it can be shipped into a box whose `agentbox-ctl` was baked before the agent
   * existed. A closure here would foreclose that.
   */
  boxRunEnv: Record<string, string>;
  caps: AgentCapabilities;
  /**
   * Box->host (`agentbox download <agent>`) descriptor.
   *
   * Separate from `staticPaths` on purpose: that field's `exclude`/`include` are
   * PUSH-direction hygiene (claude drops `projects`/`sessions` on the way in),
   * while the pull's real filters are different ones. Reusing it verbatim would
   * be wrong in both directions. The ROOTS do map one-to-one, which is why
   * `agentBoxDir` derives them from `staticPaths[0].boxDir` instead of
   * restating them.
   *
   * Absent means the agent has no box->host sync — which is the silent gap that
   * made `download` easy to forget when adding an agent.
   */
  pull?: AgentPullSpec;
  /**
   * Extra in-box files ctl should watch, beyond `credential` (which is always
   * watched). This is the hook a custom agent uses to say "sync these back".
   *
   * The credential watch is implicit and always `fanout`; anything declared here
   * defaults to `backup` — see `AgentWatchSpec.sync`.
   */
  watch?: readonly AgentWatchSpec[];
}

/** One extra file an agent asks ctl to watch. */
export interface AgentWatchSpec {
  /** Absolute in-box path. */
  path: string;
  /**
   * `backup` (default) lands the file on the host and stops. `fanout` also
   * re-distributes it to every other box, which is correct ONLY for a rotating
   * secret — an agent's own logs or transcripts must never fan out.
   */
  sync?: 'fanout' | 'backup';
  /** Host destination, relative to the box's host workspace. */
  hostDest?: string;
}

/**
 * How `download <agent>` enumerates what a box has that the host doesn't.
 *
 * Two strategies because the agents genuinely differ in SHAPE, not just data:
 * codex/opencode are flat item lists, while claude's unit is "child of a
 * category dir" plus a 2-level plugin cache and a JSON registry merge. A single
 * strategy would have to model claude's case for everyone.
 */
export interface AgentPullSpec {
  /**
   * Flat items (files or dirs) directly under a root — codex, opencode.
   * `group` selects which root: `data` is `staticPaths[0].boxDir`, any other
   * value is that dir plus the matching entry's `relocToSubpath`.
   */
  items?: readonly { group: string; names: readonly string[] }[];
  /**
   * Roots that exist ONLY in the pull direction, named directly rather than
   * resolved through `staticPaths`.
   *
   * Session logs are the motivating case and are genuinely pull-only: you would
   * never PUSH transcripts into a box, and every agent's `staticPaths.exclude`
   * already drops them on the way in (claude: `projects`/`sessions`/
   * `history.jsonl`; codex: `sessions`/`archived_sessions`/`log`; opencode:
   * `storage`/`log`/`snapshot`). With groups resolving only through
   * `staticPaths`, such a location had nowhere to be declared.
   *
   * Roots that exist in BOTH directions keep deriving from `staticPaths` — this
   * is an alternative, not a replacement.
   */
  roots?: readonly {
    /** Group name referenced by `items[].group`. */
    group: string;
    /** Absolute in-box directory. */
    boxDir: string;
    /** Host destination, as path segments under `os.homedir()`. */
    hostHomeRel: readonly string[];
  }[];
  /**
   * Directories whose CHILDREN are the unit — claude's `skills`/`agents`/
   * `commands`. Each child dir is one item.
   */
  categories?: readonly string[];
  /**
   * JSON files merged additively rather than copied — claude's plugin
   * registries. `projection` names the sub-object holding the entries (`root`
   * for a flat map). Never overwrites an existing host key.
   */
  jsonMerges?: readonly { rel: string; projection: 'root' | 'plugins' }[];
}
