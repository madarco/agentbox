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

const CLAUDE_BOX_DIR = '/home/vscode/.claude';
const CODEX_BOX_DIR = '/home/vscode/.codex';
const OPENCODE_BOX_DIR = '/home/vscode/.local/share/opencode';

export const AGENT_SYNC_SPECS: readonly AgentSyncSpec[] = [
  {
    id: 'claude',
    aliases: ['claude-code'],
    sessionName: 'claude',
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
    boxRunEnv: () => ({}),
    caps: { resume: true, teleport: 'full', activitySource: 'scraper' },
  },
  {
    id: 'codex',
    aliases: [],
    sessionName: 'codex',
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
    boxRunEnv: () => ({}),
    caps: { resume: true, teleport: 'full', activitySource: 'scraper' },
  },
  {
    id: 'opencode',
    aliases: [],
    sessionName: 'opencode',
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
    boxRunEnv: () => ({
      OPENCODE_CONFIG_DIR: `${OPENCODE_BOX_DIR}/config`,
      XDG_STATE_HOME: `${OPENCODE_BOX_DIR}/.state`,
    }),
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
