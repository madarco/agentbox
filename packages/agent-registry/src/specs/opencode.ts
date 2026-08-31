/**
 * OpenCode's registry row — the DATA half of this package.
 *
 * Imports only the two dependency-free leaves (`@agentbox/core` for the
 * contract, `@agentbox/config` for the host state dir) on purpose: this entry is read by
 * the agent registry, which `sandbox-core` depends on, which in turn everything
 * depends on. Anything heavier here is a dependency cycle. See this package's
 * `tsup.config.ts`.
 */

import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';
import { BOX_USER, BOX_HOME, BOX_CREDS_DIR } from '@agentbox/core';
import type { AgentSyncSpec } from '@agentbox/core';

const OPENCODE_BOX_DIR = `${BOX_HOME}/.local/share/opencode`;
/** Baked alongside the setup guide: opencode's activity-reporting plugin. */
const OPENCODE_PLUGIN_PATH = '/usr/local/share/agentbox/opencode-agentbox-plugin.js';

export const opencodeSpec: AgentSyncSpec = {
  id: 'opencode',
  aliases: [],
  sessionName: 'opencode',
  binary: 'opencode',
  install: {
    recipe: { kind: 'npm', package: 'opencode-ai' },
    runAs: 'root',
    postInstall: [
      `install -d -o ${BOX_USER} -g ${BOX_USER} ${OPENCODE_BOX_DIR} ${BOX_CREDS_DIR}/opencode`,
      `ln -sfn ${BOX_CREDS_DIR}/opencode/auth.json ${OPENCODE_BOX_DIR}/auth.json`,
      `chown -R ${BOX_USER}:${BOX_USER} ${BOX_CREDS_DIR} ${BOX_HOME}/.local`,
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
  // OpenCode auto-loads any JS/TS file under `$OPENCODE_CONFIG_DIR/plugins/`
  // at startup; this one subscribes to its event bus and shells
  // `agentbox-ctl opencode-state`. It is the ONLY source of opencode activity
  // (`activitySource: 'plugin'`), which is why its absence on the cloud
  // providers left every cloud opencode box reporting `unknown`.
  seeds: [
    {
      bakedPath: OPENCODE_PLUGIN_PATH,
      destRel: 'config/plugins/agentbox-state.js',
      sharedAsset: 'opencode-agentbox-plugin.js',
      label: 'the agentbox-state plugin',
    },
  ],
  caps: {
    resume: false,
    teleport: 'stub',
    // OpenCode stores sessions in a multi-tenant SQLite DB with sibling
    // storage/, snapshot/ and repos/ dirs. A naive teleport would copy the
    // whole DB (leaking every other project's sessions into the sandbox), and
    // row-level extraction is real work: foreign keys, FTS indices, and
    // snapshot artifacts that live on disk outside the DB.
    teleportStubReason:
      'OpenCode session teleport is not yet supported in agentbox (sessions live in a multi-tenant SQLite DB at ~/.local/share/opencode/opencode.db; per-project extraction is tracked for a follow-up). Run `agentbox opencode` without -c / --resume to start a fresh session, or open an issue if you need this feature.',
    activitySource: ['plugin'],
  },
  // Box->host: two roots. `data` is staticPaths[0].boxDir; `config` is that
  // dir plus the config entry's relocToSubpath. The THIRD staticPaths entry
  // (~/.local/state/opencode, `update: true`) is deliberately absent: it is
  // newest-wins two-way state, and newest-wins is the opposite of pull's
  // additive never-overwrite rule.
  pull: {
    items: [
      { group: 'data', names: ['auth.json'] },
      {
        group: 'config',
        names: [
          'opencode.json',
          'opencode.jsonc',
          'agents',
          'commands',
          'modes',
          'plugins',
          'skills',
          'tools',
          'themes',
        ],
      },
    ],
  },
};
