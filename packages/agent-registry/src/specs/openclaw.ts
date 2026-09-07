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

import { BOX_HOME, BOX_USER, agentDirPrelude } from '@agentbox/core';
import type { AgentSyncSpec } from '@agentbox/core';

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
/** The per-provider box facts. Claude reads it directly; codex folds it in too. */
const BOX_FACTS = '/etc/claude-code/CLAUDE.md';
const AGENTBOX_CTX_DIR = '/workspace/.agentbox';
/** First line of the generated file: makes a re-run idempotent, and says whose it is. */
const CTX_SENTINEL = '<!-- agentbox:box-facts (generated every boot; edit AGENTS.md instead) -->';

/**
 * The keys AgentBox OWNS in openclaw's config, applied through openclaw's own
 * validated merge. Deliberately not the `openclaw:` overlay in agentbox.yaml —
 * that is the user's, and `configRender` reads only from there.
 *
 * `openclaw-render` applies the user's overlay afterwards and sends only the
 * keys they CHANGED, so these survive unless the user names the same key, which
 * is the precedence we want.
 */
const AGENTBOX_OWNED_CONFIG = JSON.stringify({
  skills: { load: { extraDirs: [AGENTBOX_SKILLS_DIR] } },
  hooks: {
    internal: {
      enabled: true,
      entries: { 'bootstrap-extra-files': { enabled: true, paths: ['.agentbox/AGENTS.md'] } },
    },
  },
});

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
    `if [ -f ${BAKED_SETUP_SKILL} ]; then`,
    `  D=${AGENTBOX_SKILLS_DIR}/agentbox-setup`,
    '  (sudo -n mkdir -p "$D" 2>/dev/null || mkdir -p "$D") || true',
    `  (sudo -n install -m 0644 ${BAKED_SETUP_SKILL} "$D/SKILL.md" 2>/dev/null ||`,
    `   install -m 0644 ${BAKED_SETUP_SKILL} "$D/SKILL.md") || true`,
    'fi',
    // The box facts, written atomically so a reader never sees a half file.
    `if [ -f ${BOX_FACTS} ]; then`,
    `  mkdir -p ${AGENTBOX_CTX_DIR} || true`,
    `  TMP=${AGENTBOX_CTX_DIR}/AGENTS.md.agentbox.tmp`,
    '  {',
    `    printf '%s\\n\\n' '${CTX_SENTINEL}'`,
    `    cat ${BOX_FACTS}`,
    '  } > "$TMP" && mv "$TMP" ' + `${AGENTBOX_CTX_DIR}/AGENTS.md || true`,
    'fi',
    // Keep it out of the user's repo. `agentbox download` selects with
    // `git ls-files --others --exclude-standard` and deliberately does NOT apply
    // the exclude list in git mode, so the only thing that hides an untracked
    // file there is git itself. `.git/info/exclude` is per-clone and in the BOX,
    // so the user's own .gitignore is never touched.
    'if [ -d /workspace/.git ]; then',
    '  mkdir -p /workspace/.git/info || true',
    "  grep -qxF '.agentbox/' /workspace/.git/info/exclude 2>/dev/null ||",
    "    printf '%s\\n' '.agentbox/' >> /workspace/.git/info/exclude || true",
    'fi',
    // One validated merge rather than several `config set` calls.
    `printf '%s' '${AGENTBOX_OWNED_CONFIG}' | openclaw config patch --stdin >/dev/null || true`,
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
        // Everything AgentBox owns in this box: the skill root outside the
        // workspace, the derived box facts inside it, and the two config keys
        // that make openclaw read both. No `runOnce` — see the builder's doc.
        name: 'openclaw-agentbox-env',
        command: buildAgentboxContextScript(),
        needs: ['openclaw-onboard'],
      },
      {
        name: 'openclaw-render',
        command: 'agentbox-ctl agent render openclaw',
        // After the AgentBox keys, so the user's overlay is the last word on any
        // key they and we both name.
        needs: ['openclaw-agentbox-env'],
      },
    ],
    // The Control UI asks for the gateway token on first load, and openclaw's
    // own `config get` redacts it (PoC), so it is read from the raw JSON.
    urlFields: [
      { label: 'token', file: `${OPENCLAW_BOX_DIR}/openclaw.json`, jsonPath: 'gateway.auth.token' },
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
  pull: { categories: ['agents'] },
};
