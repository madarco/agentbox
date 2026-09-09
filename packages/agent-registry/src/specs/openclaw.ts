/**
 * OpenClaw's registry row — the first `surface: 'service'` agent.
 *
 * Everything that makes it different from the four TUI rows is on `caps`,
 * `service` and `configRender`, which is the point of Phase 2/3: nothing
 * branches on the id. What the row says is "this agent is a daemon the box
 * hosts": ctl's supervisor runs it, its readiness is an HTTP probe rather than a
 * tmux session, and the box's web URL is its Control UI.
 *
 * Imports only the two dependency-free leaves, like every other spec (see
 * `spec-purity.test.ts`).
 *
 * The shape below is what the Phase 0 PoC measured, not what the plan assumed —
 * see `docs/plans/service-boxes-plan.md` §"Established facts". Three of its
 * findings are load-bearing here:
 *
 *  - the gateway binds LOOPBACK and generates its own auth token, so there is no
 *    `gateway.bind` override and no auto-secret. ctl's `WebProxy` forwards
 *    `:80 -> 127.0.0.1:18789` inside the same container, which is both
 *    sufficient and strictly safer than widening the bind.
 *  - `openclaw config patch --stdin` is a validated recursive merge openclaw
 *    performs on its own file, so `configRender` delegates to it rather than
 *    hand-rolling a merge.
 *  - `openclaw config get gateway.auth.token` answers `__OPENCLAW_REDACTED__`,
 *    so `service.urlFields` reads the token out of the raw JSON instead.
 *
 * INSTALL IS ON DEMAND, NEVER BAKED. `npm i -g openclaw` lands ~893 MB — a ~29%
 * increase on the 3.1 GB base image. Baking it would also shift the build-context
 * fingerprint and stale every provider's base snapshot.
 */

import { BOX_HOME, BOX_USER, IDENTITY_RULES_SENTINEL, agentDirPrelude } from '@agentbox/core';
import type { AgentSyncSpec } from '@agentbox/core';
import { codexSpec } from './codex.js';

/** OpenClaw's state root: config, sqlite state, per-agent dirs, migrations. */
const OPENCLAW_BOX_DIR = `${BOX_HOME}/.openclaw`;
/**
 * Where openclaw keeps its auth-profile key: `~/.config/openclaw`, OUTSIDE the
 * state dir, and empty after a plain `onboard`.
 *
 * It is relocated into the state root as `xdg/` and symlinked back, the same
 * arrangement opencode uses for its config dir — one docker volume can only be
 * mounted once, and a second dir under `$HOME` would otherwise live in the
 * container's writable layer and be lost on re-create.
 */
const OPENCLAW_XDG_SUBPATH = 'xdg';
const OPENCLAW_XDG_BOX_DIR = `${OPENCLAW_BOX_DIR}/${OPENCLAW_XDG_SUBPATH}`;
const OPENCLAW_XDG_LINK = `${BOX_HOME}/.config/openclaw`;
/** Loopback port the gateway binds. Named once — probe, expose and URL all read it. */
const GATEWAY_PORT = 18789;

/**
 * Where AgentBox keeps the skills it owns, and the box "system prompt" it
 * derives. Both are AgentBox's, not the user's.
 *
 * The skill lives OUTSIDE the workspace on purpose: `skills.load.extraDirs` is
 * documented for exactly this ("shared skill packs ... without copying them
 * into the OpenClaw workspace"), at LOWEST precedence, so a user skill of the
 * same name wins. Nothing about it travels with `agentbox clone`.
 *
 * The prompt file cannot do the same. openclaw's `bootstrap-extra-files` hook
 * resolves every path from the workspace and REALPATH-CHECKS it, so a symlink
 * out is refused, and only the six canonical bootstrap basenames are accepted —
 * hence a real `AGENTS.md`, inside `/workspace`, under a namespaced dir.
 */
const AGENTBOX_SKILLS_DIR = '/opt/agentbox/skills';
/** Baked into every provider's base image; see each `install-box.sh`. */
const BAKED_SETUP_SKILL = '/usr/local/share/agentbox/setup-guide.md';
/** The identity wizard, baked the same way. Absent on a base baked before it. */
const BAKED_IDENTITY_SKILL = '/usr/local/share/agentbox/identity-skill.md';
/**
 * What the identity wizard writes into `agentbox.yaml`, and therefore how we ask
 * "has this bot done it yet?". A comment rather than a key so the check is a
 * plain grep and needs no yaml parser inside a shell script — and so the user
 * can see, in their own file, what wrote it.
 */
const IDENTITY_SENTINEL = IDENTITY_RULES_SENTINEL;
/** The workspace file the sentinel lives in. */
const WORKSPACE_YAML = '/workspace/agentbox.yaml';
/** The per-provider box facts. Claude reads it directly; codex folds it in too. */
const BOX_FACTS = '/etc/claude-code/CLAUDE.md';
const AGENTBOX_CTX_DIR = '/workspace/.agentbox';
/** First line of the generated file: makes a re-run idempotent, and says whose it is. */
const CTX_SENTINEL = '<!-- agentbox:box-facts (generated every boot; edit AGENTS.md instead) -->';

/** Scratch path for the merge program; removed again as soon as it has run. */
const MERGE_PROGRAM_PATH = '/tmp/agentbox-openclaw-config-merge.cjs';

/** Workspace-relative path of the generated prompt file, as the hook names it. */
const CTX_REL_PATH = '.agentbox/AGENTS.md';

/**
 * Build the config patch AgentBox applies, as a MEMBERSHIP assertion on the two
 * arrays rather than a value for them.
 *
 * Both keys are arrays, and `openclaw config patch` replaces an array wholesale
 * rather than merging it — so sending a literal `[ourDir]` every boot would be a
 * silent data-loss bug, not merely rude. `openclaw-render` re-sends only the
 * overlay keys that CHANGED since its last render, so a user value that is
 * stable (in `agentbox.yaml`, or set in the box with `openclaw config set`)
 * would not be re-asserted afterwards: it would survive the first boot and
 * vanish on the second.
 *
 * Reading the current value and unioning ours in keeps AgentBox's claim to the
 * narrowest true one — "our skills dir is on the list, our prompt file is in the
 * bootstrap set" — and leaves every other entry, and every neighbouring key,
 * alone. An explicit `enabled: false` on the hook is preserved too: disabling
 * the box facts is a choice the user is allowed to make and have stick.
 *
 * Emitted as a program rather than a static JSON blob because the merge has to
 * happen IN the box, against that box's live config. node is guaranteed there —
 * openclaw is a node application.
 *
 * It is handed the current values rather than reading `openclaw.json` itself.
 * That file is JSON5 — openclaw reads a config with a `//` comment in it quite
 * happily, and `JSON.parse` throws on the same file (both verified in a box) —
 * so parsing it here would see `{}` for a commented config and clobber exactly
 * the arrays this program exists to preserve. `openclaw config get` is the
 * tool's own reader, and it also resolves defaults, profiles and env overrides.
 *
 * An unreadable value is treated as UNSET, which is only safe because the caller
 * gates the whole step on `openclaw config validate`: openclaw prints nothing
 * and exits 1 both for a path that is merely unset and for one it cannot read,
 * so the exit code alone cannot separate a fresh box from a broken config.
 */
export const OPENCLAW_CONFIG_MERGE_PROGRAM = `
const [skillDir, ctxPath, rawDirs, rawEntries, rawHooksEnabled] = process.argv.slice(2);
const read = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const withMember = (arr, v) =>
  Array.isArray(arr) ? (arr.includes(v) ? arr.slice() : [...arr, v]) : [v];
const entry = read(rawEntries)?.['bootstrap-extra-files'] ?? {};
process.stdout.write(
  JSON.stringify({
    skills: { load: { extraDirs: withMember(read(rawDirs), skillDir) } },
    hooks: {
      internal: {
        enabled: read(rawHooksEnabled) === false ? false : true,
        entries: {
          'bootstrap-extra-files': {
            ...entry,
            enabled: entry.enabled === false ? false : true,
            paths: withMember(entry.paths, ctxPath),
          },
        },
      },
    },
  }),
);
`;

/** Single-quote a value for the POSIX shell. */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Appended to the generated box facts while this workspace has no identity
 * rule-set. It is a prompt, so it says what is at stake rather than naming a
 * command: the agent decides when to act on it.
 */
const IDENTITY_NUDGE_TEXT = [
  '',
  '## Your identity is not portable yet',
  '',
  'This workspace declares no `identity` replacement rules, so a bot spawned',
  'from it with `agentbox clone` would introduce itself with YOUR name and',
  'answer to YOUR handle. On your first turn, follow the `agentbox-identity`',
  'skill once to write them, then carry on with whatever you were asked.',
  '',
].join('\n');

/**
 * The model-auth task: turn a borrowed Codex login into OpenClaw's own OpenAI
 * OAuth profile. Reads the file the host seeded at codex's OWN credential path
 * (`AgentSyncSpec.modelAuth.borrows`), so nothing here knows how the host chose
 * or moved it.
 *
 * Every step below was measured on openclaw 2026.9.3, not read from the plan:
 *
 *  - The auth store is SQLite (`agents/<id>/agent/openclaw-agent.sqlite`); the
 *    retired `auth-profiles.json` / `credentials/oauth.json` are never read at
 *    runtime, so writing one is not a seam.
 *  - `openclaw migrate apply codex ... --item auth:openai` is the supported,
 *    non-interactive import of a Codex CLI home. It lives in the official
 *    `@openclaw/codex` plugin (ClawHub), which is also the harness the fresh
 *    onboard's default model (`openai/gpt-5.6-sol`) runs on — so installing it
 *    completes the default rather than changing it. The install is ~17s and
 *    lands in the config volume, so it is paid once per box.
 *  - A bare `~/.codex/auth.json` is enough for `models status` to SHOW a
 *    bootstrapped `openai:default` — reported as `source: store`, status `ok`,
 *    indistinguishable from a real row — but a turn on it fails with
 *    `selected_auth_profile_unavailable`. So OpenClaw's own status is NOT the
 *    gate for "already imported"; the import is what makes the profile real.
 *  - The import applies on every run. After it OpenClaw owns the profile and
 *    refreshes it in its own store, and OpenAI does not invalidate the prior
 *    refresh token on rotation (two boxes seeded from one host file refreshed
 *    independently and every chain, the host's included, stayed valid). So a
 *    re-import is never needed for freshness, and would only replace the box's
 *    own newer chain with the seed's.
 *
 * Hence the gate is the SEED itself: a hash of the file, recorded beside
 * `.agentbox-overlay.json` once an import succeeds. Unchanged file, no work;
 * a re-pushed login (the host logged in again) imports again. Idempotent and
 * exit 0 on every "nothing to do": no seeded file, a file that is not a Codex
 * login, or one already imported. The gateway is ordered after this task
 * (`needs`), so the plugin it installs is loaded on the gateway's first start
 * rather than needing a restart.
 */
function buildModelAuthScript(): string {
  const auth = codexSpec.credential!.boxAbsPath;
  const home = auth.slice(0, auth.lastIndexOf('/'));
  return [
    'set -u',
    `auth=${sq(auth)}`,
    `marker=${sq(MODEL_AUTH_MARKER)}`,
    'if [ ! -s "$auth" ]; then echo "openclaw-model-auth: no borrowed Codex login at $auth"; exit 0; fi',
    // Shape gate, so a half-written or API-key-only file is "nothing to
    // ingest" rather than a failed import.
    `if ! node -e ${sq(MODEL_AUTH_IS_CODEX_LOGIN)} "$auth"; then echo "openclaw-model-auth: $auth is not a Codex ChatGPT login"; exit 0; fi`,
    'seen=$(sha256sum "$auth" | cut -d" " -f1)',
    'if [ -f "$marker" ] && [ "$(cat "$marker")" = "$seen" ]; then',
    '  echo "openclaw-model-auth: this Codex login is already imported"',
    '  exit 0',
    'fi',
    // The plugin owns both the import command and the harness the default
    // model runs on.
    `if [ ! -d ${sq(`${OPENCLAW_BOX_DIR}/extensions/codex`)} ]; then`,
    '  echo "openclaw-model-auth: installing the @openclaw/codex plugin"',
    '  openclaw plugins install clawhub:@openclaw/codex || exit 0',
    'fi',
    'echo "openclaw-model-auth: importing the Codex login into the OpenClaw auth store"',
    // `--no-backup --force`: the pre-migration archive would snapshot a state
    // dir that is fresh on the boot this runs, and the migration report is
    // still written. `--item auth:openai` keeps skills/plugins/config out.
    `if openclaw migrate apply codex --from ${sq(home)} --include-secrets --item auth:openai --yes --no-backup --force; then`,
    '  printf %s "$seen" > "$marker" && chmod 600 "$marker"',
    'fi',
    'exit 0',
  ].join('\n');
}

/** Hash of the last seed imported. Beside the overlay record: AgentBox-owned, per box. */
const MODEL_AUTH_MARKER = `${OPENCLAW_BOX_DIR}/.agentbox-model-auth.sha256`;

/** argv[1] is the file. Exit 0 iff it is a Codex ChatGPT login with a refresh token. */
const MODEL_AUTH_IS_CODEX_LOGIN = `
const j = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
process.exit(typeof j?.tokens?.refresh_token === 'string' && j.tokens.refresh_token.length > 0 ? 0 : 1);
`;

/**
 * Teach the box's gateway where it is running.
 *
 * Runs on EVERY supervisor start, not once: the prompt file sits in the
 * workspace, so `agentbox clone` carries a copy of the SOURCE box's facts into
 * the new one. Regenerating overwrites it from this box's own `/etc/claude-code`
 * before the gateway ever reads it — which is what makes a clone, a re-provision
 * or a move to another provider self-correcting rather than quietly wrong.
 *
 * Best-effort throughout: none of this is worth failing a box over, so every
 * step is guarded and the task still exits 0 on a base too old to carry the
 * baked files.
 */
function buildAgentboxContextScript(): string {
  return [
    'set -u',
    // The skill. COPIED, not symlinked, and as `<name>/SKILL.md` rather than a
    // flat `.md` — both measured against openclaw 2026.9.2, which discovered
    // neither other shape: it takes skills as directories, and rejects a symlink
    // whose real target sits outside the source root unless that target is in
    // `skills.load.allowSymlinkTargets`. Re-copied every boot, so a re-baked
    // base image still propagates.
    ...[
      [BAKED_SETUP_SKILL, 'agentbox-setup'],
      [BAKED_IDENTITY_SKILL, 'agentbox-identity'],
    ].flatMap(([src, name]) => [
      `if [ -f ${src} ]; then`,
      `  D=${AGENTBOX_SKILLS_DIR}/${name}`,
      '  (sudo -n mkdir -p "$D" 2>/dev/null || mkdir -p "$D") || true',
      `  (sudo -n install -m 0644 ${src} "$D/SKILL.md" 2>/dev/null ||`,
      `   install -m 0644 ${src} "$D/SKILL.md") || true`,
      'fi',
    ]),
    // The box facts, written atomically so a reader never sees a half file.
    // The nudge text, as a shell variable so the printf below stays a single
    // short line and the prose can carry the punctuation it needs.
    `IDENTITY_NUDGE=${sq(IDENTITY_NUDGE_TEXT)}`,
    `if [ -f ${BOX_FACTS} ]; then`,
    `  mkdir -p ${AGENTBOX_CTX_DIR} || true`,
    `  TMP=${AGENTBOX_CTX_DIR}/AGENTS.md.agentbox.tmp`,
    '  {',
    `    printf '%s\\n\\n' '${CTX_SENTINEL}'`,
    `    cat ${BOX_FACTS}`,
    // The identity nudge. Conditional on the workspace NOT already declaring the
    // rule-set, and regenerated every boot, so it disappears by itself once the
    // bot has written one -- the yaml is the only state, and there is no marker
    // to go stale. A supervisor task cannot do this job: writing these rules
    // means reading your own SOUL.md and deciding which words are you, which is
    // a judgement only the agent can make, on a turn only the agent can take.
    `    if [ -f ${BAKED_IDENTITY_SKILL} ] && ! grep -qs '${IDENTITY_SENTINEL}' ${WORKSPACE_YAML} 2>/dev/null; then`,
    `      printf '%s' "$IDENTITY_NUDGE"`,
    '    fi',
    '  } > "$TMP" && mv "$TMP" ' + `${AGENTBOX_CTX_DIR}/AGENTS.md || true`,
    'fi',
    // One validated merge rather than several `config set` calls. The patch is
    // COMPUTED from the box's live config (see the program's own comment) so the
    // two arrays gain our entry instead of being replaced by it.
    //
    // Gated on openclaw's own validator. A `config get` prints nothing and exits
    // 1 both for a value that is merely unset and for one it cannot read, so
    // without this gate a broken config would look like a fresh box and be
    // overwritten with just our entry. With the config known good, an empty read
    // means genuinely unset, which is the one case where writing ours alone is
    // right.
    'if openclaw config validate >/dev/null 2>&1; then',
    `  DIRS=$(openclaw config get 'skills.load.extraDirs' 2>/dev/null || true)`,
    // The whole `entries` object, by plain dot path, and the one key is picked out
    // in the program. Reading `entries['bootstrap-extra-files']` directly does
    // work on 2026.9.2, but it leans on the CLI's bracket-and-quote parsing for a
    // key with a hyphen in it — and a get that fails here is indistinguishable
    // from unset, which would silently replace the user's `paths`.
    `  ENTRIES=$(openclaw config get 'hooks.internal.entries' 2>/dev/null || true)`,
    `  HOOKS=$(openclaw config get 'hooks.internal.enabled' 2>/dev/null || true)`,
    // Written to a file first: a quoted heredoc keeps the program safe from the
    // shell, and it avoids process substitution, which some provider bases have
    // no `/dev/fd` for.
    `  PROG=${MERGE_PROGRAM_PATH}`,
    '  cat > "$PROG" <<\'AGENTBOX_MERGE_EOF\'',
    OPENCLAW_CONFIG_MERGE_PROGRAM.trim(),
    'AGENTBOX_MERGE_EOF',
    `  node "$PROG" ${AGENTBOX_SKILLS_DIR} ${CTX_REL_PATH} "$DIRS" "$ENTRIES" "$HOOKS" |`,
    '    openclaw config patch --stdin >/dev/null || true',
    '  rm -f "$PROG" || true',
    'fi',
    'exit 0',
  ].join('\n');
}

export const openclawSpec: AgentSyncSpec = {
  id: 'openclaw',
  aliases: [],
  // The tmux session `service.repl` opens on demand. NOT an agent session: the
  // gateway runs under ctl whether or not anyone is attached, and
  // `activitySource: []` still tells ctl not to probe this name — see `caps`.
  // Nothing creates it until someone runs `agentbox attach`.
  sessionName: 'openclaw',
  binary: 'openclaw',
  install: {
    // `allowScripts` is load-bearing: npm >= 12 blocks lifecycle scripts by
    // default and openclaw's own do real setup work. It covers openclaw's
    // scripts ONLY -- four dependency scripts (koffi, tree-sitter-bash,
    // protobufjs, @google/genai) stay skipped. The PoC confirmed openclaw
    // installs, launches and serves without them; a feature routed through one
    // of those deps may be degraded.
    recipe: { kind: 'npm', package: 'openclaw', allowScripts: true },
    runAs: 'root',
    postInstall: [
      // EVERY dir, not just the leaf, for the reason pi's row documents: GNU
      // `install -d -o u -g g a/b` applies ownership to the FINAL component
      // only, so a nested path alone leaves the parent root-owned and the later
      // static-config stage (which runs as the box user) cannot write it.
      // No creds-subdir argument: with no `credential` declared there is no
      // subpath of the shared credentials volume to create a mount point for.
      ...agentDirPrelude([OPENCLAW_BOX_DIR, OPENCLAW_XDG_BOX_DIR, `${BOX_HOME}/.config`]),
      // Point `~/.config/openclaw` into the state root so it rides the one
      // config volume. `ln -sfn` onto an existing DIRECTORY would create the
      // link inside it, so the real dir goes first -- it is either absent or
      // the empty one openclaw/our own prelude made.
      `rm -rf ${OPENCLAW_XDG_LINK}`,
      `ln -sfn ${OPENCLAW_XDG_BOX_DIR} ${OPENCLAW_XDG_LINK}`,
      `chown -h ${BOX_USER}:${BOX_USER} ${OPENCLAW_XDG_LINK}`,
    ].join(' && '),
  },
  dockerVolume: 'agentbox-openclaw-config',
  staticPaths: [
    {
      hostHomeRel: ['.openclaw'],
      boxDir: OPENCLAW_BOX_DIR,
      // Push excludes. Everything here is IDENTITY, and openclaw does not
      // support two gateways sharing one: pushing the host's `openclaw.json`
      // into a box would hand the box the host gateway's token and channel
      // pairings, which is exactly the failure `clone`'s fresh-identity rule
      // exists to prevent. What DOES carry in is the user's content —
      // `agents/`, and anything else they keep beside it.
      //
      // `tmp` is excluded for a second reason: it holds lock sqlites under a
      // directory whose name is keyed by the box user's uid, which differs per
      // provider (docker 1000, vercel 1001, e2b 1002).
      exclude: [
        'openclaw.json',
        'openclaw.json.bak',
        'config-journal-fingerprint.key',
        '.agentbox-overlay.json',
        '.agentbox-model-auth.sha256',
        // Per-gateway exec-approval state, plus the `.migrated.<hash>` archives
        // doctor leaves beside it. MEASURED: the host's copy from an older
        // openclaw rode the cloud static push into a 2026.9.3 box, and every
        // turn there failed with "Legacy exec approvals exist ... run doctor".
        'exec-approvals.json*',
        'state',
        'migration',
        'tmp',
      ],
    },
    // Relocated under the state root rather than given its own `boxDir`: one
    // docker volume, one mount, and the symlink above makes the box path work.
    // Same shape as opencode's config entry.
    {
      hostHomeRel: ['.config', 'openclaw'],
      boxDir: OPENCLAW_BOX_DIR,
      relocToSubpath: OPENCLAW_XDG_SUBPATH,
    },
  ],
  // NO `credential`: openclaw has no host-side credential to sync. Its gateway
  // token is generated per box by `openclaw onboard` and must never leave that
  // box, so there is no host backup to read, nothing to push at create, no
  // subpath of the shared credentials volume to reserve, and no credential watch.
  //
  // Pointing this at `openclaw.json` to fill the slot would be harmful, not
  // redundant: the credential watch is FANOUT by contract
  // (`buildAgentDescriptors` emits `sync: 'fanout'` for every credential it
  // sees), so every other openclaw box would receive box #1's gateway identity
  // and channel pairings — the multi-tenancy failure openclaw forbids, and the
  // one `clone`'s fresh-identity rule exists to prevent.
  //
  // Channel tokens are real secrets, but they ride a `carry:` entry into a 0600
  // env file and the overlay references them by name; AgentBox never holds them.
  //
  // A MODEL-PROVIDER login is the one host secret it does consume, and that is
  // `modelAuth`, not `credential`: the host seeds codex's file at codex's own
  // path and the `openclaw-model-auth` task below imports it. Absent
  // `credential` plus present `modelAuth.sources` is the shape for a consumer.
  modelAuth: {
    sources: [
      { kind: 'agent', agent: 'codex', label: 'Your Codex login (ChatGPT subscription OAuth)' },
    ],
    ingest: { kind: 'serviceTask', task: 'openclaw-model-auth' },
  },
  settings: [
    {
      key: 'modelAuth',
      type: 'enum-list',
      enumValues: ['none', 'codex'],
      default: 'none',
      description:
        'Which host login a new OpenClaw box is seeded with as its model provider. `codex` copies your Codex (ChatGPT) OAuth login into the box, where OpenClaw imports it and refreshes it independently from then on. `none` leaves model auth for you to configure in the box. `--model-auth` overrides per create.',
      // Seeded at create, never baked: the file rides the carry step.
    },
  ],
  forwardedEnvKeys: [],
  boxRunEnv: {
    // Honoured by `onboard`, which writes it to `agents.defaults.workspace`
    // (PoC #5). Set on the box env so a hand-run `openclaw` agrees with the
    // service unit.
    OPENCLAW_WORKSPACE_DIR: '/workspace',
  },
  service: {
    name: 'openclaw',
    command: 'openclaw gateway',
    restart: 'always',
    needs: ['openclaw-render'],
    // `/healthz` answers 200 and the gateway reaches ready in ~1s (PoC #8).
    readyWhen: { http: `http://127.0.0.1:${String(GATEWAY_PORT)}/healthz` },
    expose: { port: GATEWAY_PORT, as: 80 },
    // MEASURED on a live box, not assumed: the gateway answers 200 with the
    // Control UI on a direct connection and `403 proxy_attribution_required`
    // through Portless. Any ONE forwarded header does it -- `X-Forwarded-For`,
    // `X-Forwarded-Proto` and `Forwarded` each trigger it independently
    // (openclaw's `hasForwardedRequestHeaders` matches every `x-forwarded-*`).
    // `/healthz` is exempt, which is why every smoke test before this passed.
    //
    // `gateway.trustedProxies` does not rescue it. Configuring the proxy is
    // necessary but not sufficient: openclaw also requires the FORWARDED CLIENT
    // to be non-loopback (`ingress-attribution.ts`), and a browser on the same
    // machine as the proxy never is. That is deliberate -- it stops a remote
    // client claiming the loopback auth exemption by hopping through a proxy --
    // so there is no configuration that makes the proxied path work.
    rejectsProxyHeaders: true,
    // `tui` connects to the gateway this box is already running. `chat` and
    // `terminal` are aliases for `tui --local`, which start a SECOND embedded
    // runtime and ignore that gateway — measured, not assumed. No token or URL
    // argument: it defaults to the local gateway, and a loopback request with
    // no forwarded headers is `direct-local` to openclaw's own auth.
    repl: ['openclaw', 'tui'],
    tasks: [
      {
        name: 'openclaw-onboard',
        // `runOnce: 'marker'` keyed by the resolved command: a warm boot skips
        // it, so the box keeps the identity onboard generated the first time.
        runOnce: 'marker',
        command:
          'openclaw onboard --non-interactive --accept-risk --mode local ' +
          '--skip-channels --skip-health --no-install-daemon',
      },
      {
        // The borrowed model login, if the host seeded one. After onboard so
        // the agent dir and default model exist; before the gateway so the
        // plugin it may install is loaded on the first start. No `runOnce`:
        // it decides for itself, and a re-run is a no-op once imported.
        name: 'openclaw-model-auth',
        command: buildModelAuthScript(),
        needs: ['openclaw-onboard'],
      },
      {
        // Everything AgentBox owns in this box: the skill root outside the
        // workspace, the derived box facts inside it, and the two config keys
        // that make openclaw read both. No `runOnce` — see the builder's doc.
        name: 'openclaw-agentbox-env',
        command: buildAgentboxContextScript(),
        needs: ['openclaw-model-auth'],
      },
      {
        name: 'openclaw-render',
        command: 'agentbox-ctl agent render openclaw',
        // After the AgentBox keys, so the user's overlay is the last word on any
        // key they and we both name.
        needs: ['openclaw-agentbox-env'],
      },
    ],
    // The Control UI asks for the gateway token on first load. `openclaw config
    // get gateway.auth.token` redacts it (PoC), so this used to read the raw
    // `openclaw.json` -- which meant depending on where openclaw keeps its
    // secrets. `dashboard --json` is the interface it offers for exactly this,
    // and it prints the whole sign-in URL:
    //
    //   {"ok":true,"url":"http://127.0.0.1:18789/#token=…","httpUrl":…}
    //
    // `--no-open` because the daemon would otherwise try to launch a browser
    // INSIDE the box; no `--yes`, because a read must never be the thing that
    // installs or starts the gateway. Only the fragment is kept: the rest of
    // that URL is the gateway's own loopback address, and the host reaches this
    // box on a different one.
    urlFields: [
      {
        label: 'token',
        command: ['openclaw', 'dashboard', '--json', '--no-open'],
        jsonPath: 'url',
        fromUrlFragment: 'token',
        fragmentKey: 'token',
      },
    ],
  },
  configRender: {
    file: `${OPENCLAW_BOX_DIR}/openclaw.json`,
    overlayKey: 'openclaw',
    applyCmd: 'openclaw config patch --stdin',
    dryRunFlag: '--dry-run',
    validate: 'openclaw config validate',
  },
  caps: {
    surface: 'service',
    resume: false,
    teleport: 'stub',
    teleportStubReason:
      'OpenClaw is a gateway the box hosts, not a conversation you attach to. Open its Control UI with `agentbox openclaw url`.',
    // A daemon reports no agent activity, and ctl skips probing it rather than
    // reporting a permanently-`unknown` session.
    activitySource: [],
  },
  // Box->host. `agents/` only: per-agent definitions are independent items the
  // user authors in the box and may want on the host, and the pull is additive
  // and never overwrites. Everything else under the state root is identity
  // (`openclaw.json`, the journal key) or live state (`state/*.sqlite*`), and
  // pulling either onto the host would mix one gateway's identity into another.
  // `onboard --mode local` writes these into OPENCLAW_WORKSPACE_DIR, which is the
  // project workspace — verified live. It does NOT overwrite one seeded from the
  // host, so a file the user already had stays theirs.
  clone: {
    // `onboard` writes all four, so a clone would otherwise carry the SOURCE
    // bot's scaffolding. These two are regenerated for the new box as-is.
    drop: ['AGENTS.md', 'USER.md'],
    // These two ARE the bot's character, and the user wrote most of them. A
    // clone keeps the text and swaps the name through the `identity` rule-set.
    render: ['SOUL.md', 'IDENTITY.md'],
    // The channel tokens. Keyed by box name so two bots from one workspace
    // never share a Telegram/Discord identity -- which is the failure that
    // makes a spawned bot answer as the bot it was spawned from.
    perBoxCarry: [
      {
        src: '~/.agentbox/openclaw/{{AGENTBOX_BOX_NAME}}.env',
        dest: '~/.openclaw/.env',
        mode: 0o600,
        optional: true,
      },
    ],
  },
  pull: { categories: ['agents'] },
  // A backup KEEPS everything the push excludes -- `openclaw.json` IS the bot,
  // and a restore that mints a new gateway token has restored nothing. Only the
  // lock dir is dropped, because its name carries the box user's uid and that
  // differs per provider (docker 1000, vercel 1001, e2b 1002).
  stateBackup: { exclude: ['tmp'] },
};
