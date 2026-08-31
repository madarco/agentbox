/**
 * `AgentSyncSpec` — the single source of truth for every per-agent datum the
 * sync layer needs: paths, credential locations, forwarded env keys, install
 * recipes, capabilities.
 *
 * **DATA ONLY, and that is what makes an agent packageable.** Every field is a
 * string, array or plain object — nothing function-valued — so a spec can be
 * read synchronously and offline by code that must never `import()` the agent
 * it describes: the relay (whose bundle carries no workspace packages at all),
 * the hub, and `sandbox-core`, which everything depends on. Per-agent
 * *behavior* lives in that agent's own package.
 *
 * It lives in `@agentbox/core` — the zero-internal-dep leaf — rather than in
 * `sandbox-core`, so an agent package can declare its own row without importing
 * anything that would import it back. Moving it here is what lets the registry
 * be assembled FROM the agent packages instead of listing them.
 */

import type { AgentId } from './agent-kind.js';

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
   * Which staging tarball carries this source.
   *
   * `'static'` (the default) is the one-way host config baked into a cloud
   * provider's snapshot. `'state'` marks two-way runtime state that ships on
   * its own newest-wins path and must NOT be baked — a snapshot is shared by
   * every box made from it, so a per-box state file in one would be handed to
   * all of them.
   */
  stagedAs?: 'static' | 'state';
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

/**
 * One agentbox-OWNED file that has to be placed where the agent will load it.
 *
 * These are not user config and never touch the host: an activity hook, a
 * plugin, a skill. They are baked into every provider's base image at
 * `bakedPath` and copied into the agent's config root on every create/start, so
 * an image upgrade propagates instead of a stale copy pinning an old version in
 * a long-lived shared volume.
 *
 * Data rather than three near-identical `seed*` functions: the copy step was
 * the only per-agent part, and having it live in `@agentbox/sandbox-docker`
 * meant the cloud providers silently did not do it at all (a cloud OpenCode box
 * never got its state plugin, so it reported `unknown` activity forever).
 */
export interface AgentSeedSpec {
  /** Absolute in-image source. Baked into every provider base. */
  bakedPath: string;
  /**
   * Destination, RELATIVE to `staticPaths[0].boxDir` — which is both the docker
   * config volume's root and the in-box config dir, so one string serves the
   * volume copy and the in-box copy.
   */
  destRel: string;
  /**
   * Basename under the CLI's staged `runtime/_shared/`, used as the host-side
   * source when `bakedPath` is absent. That happens for real: a base snapshot
   * baked before the asset existed never carries it, and the VPS providers
   * never shipped the OpenCode plugin at all. Uploading from the host is what
   * lets the fix land without re-baking every provider's snapshot.
   */
  sharedAsset: string;
  /** Short human label for log lines ("Codex activity hooks"). */
  label: string;
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
  /**
   * Every mechanism that reports this agent's in-box activity. A LIST because
   * the real answer is plural and a single value described it wrongly: Claude is
   * hooks-primary with a promote-only scraper backstop, Codex declares hooks but
   * is scraper-primary in practice (its own hooks file calls itself
   * defense-in-depth), and OpenCode is plugin-only.
   *
   *  - `hooks`   — the agent invokes `agentbox-ctl agent-state` from its own
   *    lifecycle hooks.
   *  - `plugin`  — an agentbox-seeded plugin reports on the agent's event bus.
   *    Implies `seeds` (asserted by `agent-seed.test.ts`) — the plugin has to
   *    reach the box for this to be true.
   *  - `scraper` — ctl watches the agent's tmux pane. Only meaningful for an
   *    agent ctl actually ships a scraper for; declaring it does not create one.
   *
   * EMPTY means the agent reports nothing, and ctl will not probe its session at
   * all — a permanently-`unknown` entry in every snapshot is worse than absence.
   */
  activitySource: readonly ('hooks' | 'plugin' | 'scraper')[];
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
   * Only `npm` is used today: `box.agentInstall: npm` is the documented escape
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
  /**
   * Keep this agent out of user-facing listings — pickers, `--help`, the install
   * wizard, the `--agents` bake list. It stays fully real everywhere else: the
   * registry resolves it, the machinery iterates it, its box works.
   *
   * For an agent that exists to exercise the seam rather than to be used. The
   * repo's fourth agent is a deliberate canary: every layer that still needs
   * hand-wiring to support a new agent fails loudly while it is present, which
   * is a running count of how far "an agent is a package" actually goes.
   */
  hidden?: boolean;
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
  /**
   * Agentbox-owned files seeded into this agent's config root on create/start.
   * See {@link AgentSeedSpec}. Absent means the agent needs no seeding.
   */
  seeds?: readonly AgentSeedSpec[];
  /**
   * Extra argv prepended to every launch of this agent's binary, for flags it
   * needs in order to LOAD what `seeds` placed (codex will not read a
   * `hooks.json` without `--enable hooks --dangerously-bypass-hook-trust`).
   *
   * Prepended, never appended: codex's `resume` is a SUBCOMMAND and global
   * flags have to precede it.
   */
  launchFlags?: readonly string[];
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

/**
 * The box user's NAME, not uid: the vscode uid differs per provider
 * (docker/hetzner 1000, vercel 1001, e2b 1002) but the name is stable.
 */
export const BOX_USER = 'vscode';
export const BOX_HOME = '/home/vscode';
/** Where a cloud credential volume mounts, pivoted into each agent's real path. */
export const BOX_CREDS_DIR = `${BOX_HOME}/.agentbox-creds`;
/** Baked into every provider's base image; the source for the wizard skill. */
export const SETUP_GUIDE_PATH = '/usr/local/share/agentbox/setup-guide.md';
