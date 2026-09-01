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
  /**
   * Opt out of {@link LIVE_DATABASE_EXCLUDES} for this source.
   *
   * Only for a source whose databases are genuinely static content. Nothing
   * declares it today, and a new declarer should say why: copying a live SQLite
   * file is not a copy of the database (see the constant's note).
   */
  allowDatabases?: boolean;
}

/**
 * Files that are a live database's on-disk representation, never safe to copy.
 *
 * A running agent keeps its data in a write-ahead log, so the main file alone is
 * stale or empty and the triple copied together is a torn read. Measured on a
 * real box: codex's `state_5.sqlite` was 4 KB with a 1.79 MB `-wal`.
 *
 * Applied to EVERY agent's push rather than enumerated per agent, because that
 * enumeration is what went stale: codex's list named `state_*` and `logs_*`, and
 * three later databases (`goals_1`, `memories_1`, `queue_1` — plus their
 * `-wal`/`-shm`) shipped into every box, carrying cross-project thread goals and
 * extracted memories with them. Verified identical under `tar --exclude` and
 * `rsync --exclude`, matching at any depth and sparing names like `notes.dbg`.
 *
 * An agent that needs a database IN the box gets it from the agent itself, which
 * rebuilds these from real state — never from a byte-copy of the host's.
 */
export const LIVE_DATABASE_EXCLUDES: readonly string[] = ['*.sqlite*', '*.db', '*.db-*'];

/**
 * Where a push is going. The difference is the CREDENTIAL file, and it is not a
 * per-agent quirk:
 *
 *  - `'snapshot'` — a cloud provider's baked base, SHARED by every box made from
 *    it. The credential must not be in there; it ships per-box afterwards.
 *  - `'volume'` — the box's own docker config volume, which IS its credential
 *    store. Excluding it there would leave the agent logged out.
 */
export type AgentPushTarget = 'snapshot' | 'volume';

/**
 * Every `--exclude` pattern one static source contributes, for one target.
 *
 * One function so the two transports cannot drift — and they had: each agent's
 * excludes existed as spec data AND again as a hardcoded rsync string, with the
 * docker copy missing `snapshot` for opencode and five host-identity files
 * (`installation_id`, `version.json`, …) for codex.
 *
 * The credential file is DERIVED from `spec.credential.boxRelPath` rather than
 * listed, which is why the specs no longer name it: it is the one entry whose
 * correct value differs by target, and deriving it is what makes a single list
 * safe for both.
 */
export function agentPushExcludes(
  spec: AgentSyncSpec,
  path: AgentPathMap,
  target: AgentPushTarget,
): string[] {
  return [
    ...(path.allowDatabases ? [] : LIVE_DATABASE_EXCLUDES),
    ...(path.exclude ?? []),
    ...(target === 'snapshot' ? [spec.credential.boxRelPath] : []),
  ];
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
  /**
   * How to tell which of two credential blobs is NEWER, when the agent's
   * credential carries an ordering field.
   *
   * `jsonPath` names a numeric JSON property (a ms-epoch expiry); the larger
   * value wins. Absent means the agent has no ordering information and the rule
   * falls back to last-writer-wins — correct for a static token, wrong for a
   * ROTATING one, which is why claude declares it: an OAuth refresh rotates the
   * refresh token, so accepting an older blob does not merely go stale, it kills
   * the login for every other box that holds the newer one.
   *
   * DATA rather than a module hook, deliberately. The fan-out that consumes it
   * runs in `agentbox-relay`, a separately spawned process bundled from
   * `@agentbox/relay` alone which never registers agent modules — a hook there
   * would silently degrade claude to last-writer-wins. The relay already reads
   * the registry synchronously, so data works everywhere the rule is needed.
   *
   * Kept off the `agents.list` descriptor on purpose: ctl never orders blobs (it
   * shape-validates and posts), so this is a host-side concern in the same
   * category as `hostBackup`, which the descriptor already strips.
   *
   * Deliberately NOT expressed by widening `realShape`: ctl drops a watch whose
   * shape it does not recognise, and an empty watch list makes it fall back to
   * the list baked into its image — which for a plugin agent, never bakeable,
   * means no credential watch at all.
   */
  freshness?: { jsonPath: readonly string[] };
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
   * Alternate ways to install the same agent, keyed by the value of the setting
   * named in {@link alternatesFrom}.
   *
   * Claude is the only declarer: `claude.install: npm` is the documented escape
   * hatch for hosts whose egress IP the Claude CDN 403s. Without this the
   * setting would silently do nothing now that the install lives here rather
   * than in a Dockerfile branch.
   */
  alternates?: Record<string, Omit<AgentInstall, 'alternates' | 'alternatesFrom'>>;
  /**
   * Which of the agent's declared {@link AgentSyncSpec.settings} selects
   * {@link alternates}. Present iff `alternates` is.
   *
   * Named explicitly rather than by a reserved key so a drift test can assert
   * the setting exists and is an enum whose values cover the map's keys — a
   * naming convention cannot be checked.
   */
  alternatesFrom?: string;
}

/**
 * Pick the install for this agent's resolved settings, falling back to the
 * default recipe.
 *
 * Generic on purpose: which setting selects an alternate is the AGENT's
 * declaration (`alternatesFrom`), so nothing here knows what `install` means.
 */
export function resolveAgentInstall(
  install: AgentInstall,
  settings?: AgentSettings,
): Omit<AgentInstall, 'alternates' | 'alternatesFrom'> {
  const key = install.alternatesFrom;
  const chosen = key ? settings?.[key] : undefined;
  const alt = typeof chosen === 'string' ? install.alternates?.[chosen] : undefined;
  return alt ?? install;
}

/**
 * One agent's resolved settings — its own config block with the declared
 * defaults applied. Opaque to everything but the agent that declared them.
 */
export type AgentSettings = Readonly<Record<string, string | boolean>>;

/**
 * A setting an agent declares for itself.
 *
 * WHY THIS IS NOT A ROLE-NAMED FIELD. `claude.install` and `claude.tui` really
 * are Claude-specific — one picks between Anthropic's installer and the npm
 * package, the other picks between Claude Code's two renderers. Generalising
 * their NAMES would be a lie; what generalises is the MECHANISM: an agent
 * declares its settings, config generates the keys, every call site carries an
 * opaque bag, and the agent's own recipe / `postInstall` / launch env is the
 * only thing that knows what they mean.
 *
 * Pure JSON like the rest of the spec, so a setting survives `agentbox agent
 * add`'s snapshot into `~/.agentbox/agents.json` and a community agent gets
 * real `agentbox config set` keys with no change to this repo.
 */
export interface AgentSettingSpec {
  /** Leaf key under the agent's own config block: `claude.install`. */
  key: string;
  type: 'string' | 'bool' | 'enum';
  /** Required when `type` is `enum`; the accepted values. */
  enumValues?: readonly string[];
  /** Applied when the user set nothing. Also what the fingerprint fold treats as absent. */
  default: string | boolean;
  /** Shown by `agentbox config list` and the docs table. */
  description: string;
  /** Hide from the default `config list` view, like the per-provider keys. */
  advanced?: boolean;
  /**
   * This setting changes what a BAKE produces, so it folds into
   * `variantFingerprint` and two values are two artifacts.
   *
   * Runtime-only settings must NOT set it — claude's `tui` rides the launch
   * env, and folding it would re-bake a whole base image for a renderer flip.
   */
  affectsBake?: boolean;
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
  /**
   * Environment that pins the agent's in-box terminal renderer, keyed by mode.
   *
   * Data rather than code because the alternative was a `binary === 'claude'`
   * branch at each launch site — and claude is only the agent this happens to
   * matter for TODAY, not the only one it could ever matter for. An agent with
   * no renderer to pin omits the field and gets an empty env.
   *
   * Claude's entry exists because its `fullscreen` renderer repaints
   * differentially: it skips cells it believes are already blank, which over a
   * network transport leaves stale characters behind in the GAPS of the text.
   * The variables are Claude Code's own overrides (verified against v2.1.250)
   * and beat the `tui` key in `~/.claude/settings.json`, so the pin holds
   * whatever a box's settings volume carries. Reported upstream behaviour, not
   * an AgentBox bug — `agentbox shell` is clean, and so is `/tui default`.
   *
   * Forwarded on the launch itself (`docker exec -e`, the cloud inner command),
   * NOT written to `/etc/agentbox/box.env`: tmux runs the binary directly rather
   * than through a login shell, so it would never source that file, and a
   * container's `docker run` env is immutable — a box created before the setting
   * existed would keep the old renderer forever.
   */
  tuiEnv?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Which of {@link settings} selects {@link tuiEnv}'s mode. Present iff
   * `tuiEnv` is — see {@link AgentInstall.alternatesFrom} for why the binding is
   * explicit rather than a reserved key name.
   */
  tuiEnvFrom?: string;
  /**
   * Settings this agent declares for itself. `@agentbox/config` generates a
   * `<id>.<key>` config key from each one, for a built-in and for an
   * `agentbox agent add`-installed package alike.
   *
   * The resolved values reach the agent three ways, all of them opaque to
   * shared code: `alternatesFrom` picks an install recipe, `tuiEnvFrom` picks a
   * launch env, and every value is exported as
   * `AGENTBOX_AGENT_SETTING_<UPPER_SNAKE_KEY>` before the agent's own `recipe`
   * and `postInstall` run — which is the escape hatch for a setting nothing in
   * this repo was written to understand.
   */
  settings?: readonly AgentSettingSpec[];
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

/**
 * The `postInstall` prelude every agent needs: its own config dir owned by the
 * box user, and its subdir of the credentials mount.
 *
 * `BOX_CREDS_DIR` IS NOT A NORMAL DIRECTORY AT RUNTIME. On the cloud providers
 * it is where the shared credentials volume mounts, and on Daytona that mount
 * is virtiofs: it presents `drwxrwxrwx root root` and rejects `chown`/`chmod`
 * with EPERM *even for root*. So the ownership of anything under it is
 * best-effort — the box user can already write it, and the mount ignores the
 * bits either way.
 *
 * Recipes used to fold both dirs into one `install -d -o vscode -g vscode`,
 * which chmods and chowns what it creates. That worked at BAKE time (no volume
 * mounted yet) and failed every runtime install on Daytona with
 * `cannot change owner and permissions of '…/.agentbox-creds/<agent>'`, so an
 * agent missing from a snapshot could never be installed into a live box.
 */
export function agentDirPrelude(agentDirs: readonly string[], credsSubdir: string): string[] {
  return [
    `install -d -o ${BOX_USER} -g ${BOX_USER} ${agentDirs.join(' ')}`,
    `mkdir -p ${BOX_CREDS_DIR}/${credsSubdir}`,
    `chown -R ${BOX_USER}:${BOX_USER} ${BOX_CREDS_DIR} 2>/dev/null || true`,
  ];
}
/** Baked into every provider's base image; the source for the wizard skill. */
export const SETUP_GUIDE_PATH = '/usr/local/share/agentbox/setup-guide.md';
