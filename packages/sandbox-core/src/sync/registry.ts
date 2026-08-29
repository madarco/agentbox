/**
 * The per-tool sync registry. `AGENT_SYNC_SPECS` is the data-driven table the
 * driver and both providers iterate instead of hardcoding three per-tool blocks
 * (`sandbox-docker/create.ts:623-763`, `sandbox-cloud/cloud-provider.ts:705-819`).
 *
 * Values here are the single source of truth mirrored by the docker constants
 * (`SHARED_*_VOLUME`, `*_FORWARDED_ENV_KEYS`, `*_CREDENTIALS_BACKUP_FILE`) and
 * the cloud `AGENT_SPECS`; a cross-check test in `@agentbox/sandbox-cloud`
 * (which can see both packages) guards against drift until those constants are
 * re-exported from here.
 */

import { join } from 'node:path';
import { STATE_DIR } from '../state.js';
import type { AgentId, AgentSyncSpec } from './agents/types.js';

/**
 * The box user's NAME, not uid: the vscode uid differs per provider
 * (docker/hetzner 1000, vercel 1001, e2b 1002) but the name is stable.
 */
const BOX_USER = 'vscode';
const BOX_HOME = '/home/vscode';
/** Where a cloud credential volume mounts, pivoted into each agent's real path. */
const CREDS_DIR = `${BOX_HOME}/.agentbox-creds`;
/** Baked into every provider's base image; the source for the wizard skill. */
const SETUP_GUIDE_PATH = '/usr/local/share/agentbox/setup-guide.md';
const CLAUDE_BOX_DIR = '/home/vscode/.claude';
const CODEX_BOX_DIR = '/home/vscode/.codex';
const OPENCODE_BOX_DIR = '/home/vscode/.local/share/opencode';

/**
 * Copy the in-box-only `/agentbox-setup` skill the first-run wizard prompt
 * references into claude's config dir.
 *
 * Shared by BOTH of claude's recipes. It used to live only on the native one,
 * which silently cost `box.claudeInstall: npm` — the CDN-403 fallback — its
 * first-run wizard, because the providers' base scripts no longer copy it
 * either (it moved onto the agent, where it belongs).
 *
 * Guarded: the source is baked into every provider's base image, but a box
 * built from an older base may not have it, and a missing wizard skill must
 * never fail an agent install. On docker the config volume mounts over this dir
 * and `seedSetupSkillIntoVolume` seeds the same content — harmless, identical
 * bytes.
 *
 * `skills` is created by its OWN `install -d`, not left to the nested path.
 * GNU `install -d -o u -g g a/b/c` applies the ownership to the FINAL component
 * only — intermediates are created root-owned. Since this runs as root, folding
 * `skills` into the nested call leaves it owned by root, and the later static
 * config stage (`sudo -u <box user> tar -C ~/.claude`) then cannot create
 * `skills/<name>` and dies with "Permission denied" — which aborts the whole
 * bake. Cost a live DigitalOcean derive to find.
 */
const SEED_SETUP_SKILL = `if [ -f ${SETUP_GUIDE_PATH} ]; then install -d -o ${BOX_USER} -g ${BOX_USER} ${CLAUDE_BOX_DIR}/skills && install -d -o ${BOX_USER} -g ${BOX_USER} ${CLAUDE_BOX_DIR}/skills/agentbox-setup && install -o ${BOX_USER} -g ${BOX_USER} -m 0644 ${SETUP_GUIDE_PATH} ${CLAUDE_BOX_DIR}/skills/agentbox-setup/SKILL.md; fi`;

export const AGENT_SYNC_SPECS: readonly AgentSyncSpec[] = [
  {
    id: 'claude',
    aliases: ['claude-code'],
    wireId: 'claude-code',
    sessionName: 'claude',
    binary: 'claude',
    // Anthropic's native installer is the canonical path (code.claude.com/docs/en/setup)
    // and drops the binary at ~/.local/bin/claude, which is what the host's
    // `.claude.json` (installMethod=native) expects. The CDN intermittently 403s
    // cloud egress IPs under load, hence the retries. The npm package is a
    // BAKE-TIME-only fallback selected by `box.claudeInstall`, not a second recipe.
    install: {
      recipe: { kind: 'script', url: 'https://claude.ai/install.sh', retries: 3 },
      runAs: 'box-user',
      // ~/.claude must exist and be box-user-owned BEFORE the named config
      // volume mounts over it: docker seeds an empty volume's permissions from
      // the mount point, so without this the volume comes up root-owned and
      // Claude Code can't write. The two symlinks are deliberately dangling at
      // build time — `_claude.json` materialises when the volume is seeded, and
      // `.credentials.json` resolves once the cloud credential volume mounts.
      postInstall: [
        `install -d -o ${BOX_USER} -g ${BOX_USER} ${CLAUDE_BOX_DIR} ${CREDS_DIR}/claude`,
        `ln -sfn ${CLAUDE_BOX_DIR}/_claude.json ${BOX_HOME}/.claude.json`,
        `ln -sfn ${CREDS_DIR}/claude/.credentials.json ${CLAUDE_BOX_DIR}/.credentials.json`,
        `chown -R ${BOX_USER}:${BOX_USER} ${CREDS_DIR}`,
        `chown -h ${BOX_USER}:${BOX_USER} ${BOX_HOME}/.claude.json ${CLAUDE_BOX_DIR}/.credentials.json`,
        SEED_SETUP_SKILL,
      ].join(' && '),
      alternates: {
        // `box.claudeInstall: npm`. npm-global drops `claude` at Node's prefix
        // bin; symlink it into ~/.local/bin so the box is indistinguishable
        // from a native install (the host's .claude.json says installMethod
        // native, and the in-box integrity check compares against that).
        npm: {
          recipe: { kind: 'npm', package: '@anthropic-ai/claude-code' },
          runAs: 'root',
          postInstall: [
            `install -d -o ${BOX_USER} -g ${BOX_USER} ${BOX_HOME}/.local/bin ${CLAUDE_BOX_DIR} ${CREDS_DIR}/claude`,
            `ln -sf "$(command -v claude)" ${BOX_HOME}/.local/bin/claude`,
            `ln -sfn ${CLAUDE_BOX_DIR}/_claude.json ${BOX_HOME}/.claude.json`,
            `ln -sfn ${CREDS_DIR}/claude/.credentials.json ${CLAUDE_BOX_DIR}/.credentials.json`,
            `chown -R ${BOX_USER}:${BOX_USER} ${CREDS_DIR}`,
            `chown -h ${BOX_USER}:${BOX_USER} ${BOX_HOME}/.local/bin/claude ${BOX_HOME}/.claude.json ${CLAUDE_BOX_DIR}/.credentials.json`,
            SEED_SETUP_SKILL,
          ].join(' && '),
        },
      },
    },
    dockerVolume: 'agentbox-claude-config',
    staticPaths: [
      {
        hostHomeRel: ['.claude'],
        boxDir: CLAUDE_BOX_DIR,
        // Static-stage excludes (single source of truth; consumed by
        // `host-stage.ts:stageClaudeStaticForUpload`). `node_modules` drops
        // host-platform binaries; `.credentials.json` ships separately; the
        // rest is per-machine runtime/history state the in-box claude
        // regenerates (`workflows` is seeded per-box at create time, not baked).
        exclude: [
          'node_modules',
          '.credentials.json',
          'projects',
          'workflows',
          'sessions',
          'history.jsonl',
          'file-history',
          'shell-snapshots',
          'backups',
          'session-env',
          'paste-cache',
          'cache',
          'telemetry',
          'tasks',
          'downloads',
          'chrome',
          'ide',
          'debug',
          'mcp-needs-auth-cache.json',
          'stats-cache.json',
        ],
      },
    ],
    credential: {
      boxRelPath: '.credentials.json',
      boxAbsPath: `${CLAUDE_BOX_DIR}/.credentials.json`,
      hostBackup: join(STATE_DIR, 'claude-credentials.json'),
      cloudMountPath: '/home/vscode/.agentbox-creds/claude',
      cloudSubpath: 'claude/',
      realShape: 'claude-oauth',
    },
    forwardedEnvKeys: [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_EFFORT',
      'ANTHROPIC_MODEL',
    ],
    boxRunEnv: {},
    caps: { resume: true, teleport: 'full', activitySource: 'scraper' },
  },
  {
    id: 'codex',
    aliases: [],
    sessionName: 'codex',
    binary: 'codex',
    // `bubblewrap` is Codex's command-sandbox backend; without it on PATH Codex
    // falls back to a bundled copy and warns on every run.
    install: {
      recipe: { kind: 'npm', package: '@openai/codex' },
      runAs: 'root',
      // Optional: Codex ships a bundled bwrap and only warns without the system
      // one, so a missing or unavailable package must not fail a box create.
      // Amazon Linux 2023 (Vercel) may not carry it at all.
      packages: ['bubblewrap'],
      packagesOptional: true,
      postInstall: [
        `install -d -o ${BOX_USER} -g ${BOX_USER} ${CODEX_BOX_DIR} ${CREDS_DIR}/codex`,
        `ln -sfn ${CREDS_DIR}/codex/auth.json ${CODEX_BOX_DIR}/auth.json`,
        `chown -R ${BOX_USER}:${BOX_USER} ${CREDS_DIR}`,
        `chown -h ${BOX_USER}:${BOX_USER} ${CODEX_BOX_DIR}/auth.json`,
      ].join(' && '),
    },
    dockerVolume: 'agentbox-codex-config',
    staticPaths: [
      {
        hostHomeRel: ['.codex'],
        boxDir: CODEX_BOX_DIR,
        // Static-stage excludes (single source of truth; consumed by
        // `host-stage.ts:stageCodexStaticForUpload`). `auth.json` ships
        // separately; `state_*.sqlite*` is the resume-cwd index (rebuilt in-box);
        // `packages`/`plugins/.plugin-appserver`/`computer-use` are heavy
        // macOS-only artifacts; the rest is host-only session/log/cache state.
        //
        // `.tmp` carve-in: the git-marketplace snapshots (`.tmp/marketplaces/`,
        // ~13 MB) must reach the box or in-box `codex plugin` breaks
        // ("marketplace root does not contain a supported manifest" — and the
        // box can't re-clone, the git shim blocks `clone`). The includes are
        // emitted BEFORE the excludes (first-match-wins): the root `.tmp/` dir
        // and the marketplaces subtree transfer, `/.tmp/*` drops its other
        // children (the ~200 MB desktop-app `bundled-marketplaces` + `plugins`
        // payloads), and the unanchored `.tmp` still blocks nested `.tmp` dirs
        // elsewhere in the tree.
        include: ['/.tmp/', '/.tmp/marketplaces/***'],
        exclude: [
          'auth.json',
          'sessions',
          'log',
          'history.jsonl',
          'hooks.json',
          'state_*.sqlite*',
          'logs_*.sqlite*',
          'external_agent_session_imports.json',
          'sqlite',
          'cache',
          'vendor_imports',
          'tmp',
          '/.tmp/*',
          '.tmp',
          '.codex-global-state.json',
          '.codex-global-state.json.bak',
          '.personality_migration',
          'shell_snapshots',
          'session_index.jsonl',
          'models_cache.json',
          'installation_id',
          'version.json',
          'packages',
          'plugins/.plugin-appserver',
          'computer-use',
          'archived_sessions',
        ],
      },
    ],
    credential: {
      boxRelPath: 'auth.json',
      boxAbsPath: `${CODEX_BOX_DIR}/auth.json`,
      hostBackup: join(STATE_DIR, 'codex-credentials.json'),
      cloudMountPath: '/home/vscode/.agentbox-creds/codex',
      cloudSubpath: 'codex/',
      realShape: 'nonempty-json',
    },
    forwardedEnvKeys: ['OPENAI_API_KEY'],
    boxRunEnv: {},
    caps: { resume: true, teleport: 'full', activitySource: 'scraper' },
  },
  {
    id: 'opencode',
    aliases: [],
    sessionName: 'opencode',
    binary: 'opencode',
    install: {
      recipe: { kind: 'npm', package: 'opencode-ai' },
      runAs: 'root',
      postInstall: [
        `install -d -o ${BOX_USER} -g ${BOX_USER} ${OPENCODE_BOX_DIR} ${CREDS_DIR}/opencode`,
        `ln -sfn ${CREDS_DIR}/opencode/auth.json ${OPENCODE_BOX_DIR}/auth.json`,
        `chown -R ${BOX_USER}:${BOX_USER} ${CREDS_DIR} ${BOX_HOME}/.local`,
        `chown -h ${BOX_USER}:${BOX_USER} ${OPENCODE_BOX_DIR}/auth.json`,
      ].join(' && '),
    },
    dockerVolume: 'agentbox-opencode-config',
    // The three-XDG-dir layout as DATA: the generic seed loop reproduces
    // `ensureOpencodeVolume`'s three-source rsync (data + config→config +
    // state→.state/opencode newest-wins) with no tool-specific control flow.
    staticPaths: [
      {
        hostHomeRel: ['.local', 'share', 'opencode'],
        boxDir: OPENCODE_BOX_DIR,
        // Static-stage excludes for the data tree (single source of truth;
        // consumed by `host-stage.ts:stageOpencodeStaticForUpload`). `auth.json`
        // ships separately; the rest is host-only runtime state.
        exclude: [
          'auth.json',
          'storage',
          'log',
          'project',
          'cache',
          'bin',
          'repos',
          'snapshot',
          'config',
          'opencode.db',
          'opencode.db-shm',
          'opencode.db-wal',
        ],
      },
      { hostHomeRel: ['.config', 'opencode'], boxDir: OPENCODE_BOX_DIR, relocToSubpath: 'config' },
      {
        hostHomeRel: ['.local', 'state', 'opencode'],
        boxDir: OPENCODE_BOX_DIR,
        relocToSubpath: '.state/opencode',
        update: true,
        exclude: ['locks'],
      },
    ],
    credential: {
      boxRelPath: 'auth.json',
      boxAbsPath: `${OPENCODE_BOX_DIR}/auth.json`,
      hostBackup: join(STATE_DIR, 'opencode-credentials.json'),
      cloudMountPath: '/home/vscode/.agentbox-creds/opencode',
      cloudSubpath: 'opencode/',
      realShape: 'nonempty-json',
    },
    forwardedEnvKeys: [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_API_KEY',
      'GROQ_API_KEY',
    ],
    boxRunEnv: {
      OPENCODE_CONFIG_DIR: `${OPENCODE_BOX_DIR}/config`,
      XDG_STATE_HOME: `${OPENCODE_BOX_DIR}/.state`,
    },
    caps: { resume: false, teleport: 'stub', activitySource: 'plugin' },
  },
];

/** Resolve a spec by canonical id or any alias (e.g. `'claude-code'` → the claude spec). */
export function resolveAgentSpec(name: string): AgentSyncSpec {
  const spec = AGENT_SYNC_SPECS.find((s) => s.id === name || s.aliases.includes(name));
  if (!spec) throw new Error(`no agent sync spec for '${name}'`);
  return spec;
}

/** The canonical ids, in registry order. */
export function agentIds(): AgentId[] {
  return AGENT_SYNC_SPECS.map((s) => s.id);
}
