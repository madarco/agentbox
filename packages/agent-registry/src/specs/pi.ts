/**
 * Pi's registry row — the DATA half of this package.
 *
 * Imports only the two dependency-free leaves (`@agentbox/core` for the
 * contract, `@agentbox/config` for the host state dir) on purpose: this entry is read by
 * the agent registry, which `sandbox-core` depends on, which in turn everything
 * depends on. Anything heavier here is a dependency cycle. See this package's
 * `tsup.config.ts`.
 */

import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';
import { BOX_USER, BOX_HOME, BOX_CREDS_DIR, agentDirPrelude } from '@agentbox/core';
import type { AgentSyncSpec } from '@agentbox/core';

/** Pi keeps everything under one root; `PI_CODING_AGENT_DIR` would move it. */
const PI_BOX_DIR = `${BOX_HOME}/.pi/agent`;
/** Baked alongside the setup guide: Pi's activity-reporting extension. */
const PI_EXTENSION_PATH = '/usr/local/share/agentbox/pi-agentbox-extension.js';

export const piSpec: AgentSyncSpec = {
  id: 'pi',
  aliases: [],
  sessionName: 'pi',
  binary: 'pi',
  install: {
    // The `pi.dev/install.sh` script is only an npm wrapper (it shells
    // `npm i -g` with a spinner), so the npm recipe is the same install with
    // one less moving part — and no CDN to 403 us.
    recipe: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
    runAs: 'root',
    postInstall: [
      // BOTH dirs, not just the leaf: GNU `install -d -o u -g g a/b` applies the
      // ownership to the FINAL component only, so passing the nested path alone
      // leaves `~/.pi` root-owned and the later static-config stage (which runs
      // as the box user) cannot write into it.
      ...agentDirPrelude([`${BOX_HOME}/.pi`, PI_BOX_DIR], 'pi'),
      `ln -sfn ${BOX_CREDS_DIR}/pi/auth.json ${PI_BOX_DIR}/auth.json`,
      `chown -h ${BOX_USER}:${BOX_USER} ${PI_BOX_DIR}/auth.json`,
    ].join(' && '),
  },
  dockerVolume: 'agentbox-pi-config',
  staticPaths: [
    {
      hostHomeRel: ['.pi', 'agent'],
      boxDir: PI_BOX_DIR,
      // Push excludes (single source of truth; `agentPushExcludes` also derives
      // the credential file and applies LIVE_DATABASE_EXCLUDES).
      //
      // `bin` is the load-bearing one: Pi vendors `fd` and `rg` there as
      // HOST-NATIVE binaries. Shipping a macOS arm64 `rg` into a Linux box
      // leaves Pi's grep/find tools present-but-unexecutable, which fails as a
      // confusing tool error rather than as a missing binary.
      //
      // `trust.json` is keyed by canonical host directory, so none of its
      // decisions mean anything in a box (`launchFlags: ['-a']` covers trust
      // there instead). `sessions` is host transcripts — pull-direction only.
      // `models-store.json` is a provider-catalog cache the box refetches.
      exclude: ['sessions', 'bin', 'models-store.json', 'trust.json'],
    },
  ],
  credential: {
    boxRelPath: 'auth.json',
    boxAbsPath: `${PI_BOX_DIR}/auth.json`,
    hostBackup: join(STATE_DIR, 'pi-credentials.json'),
    cloudMountPath: `${BOX_CREDS_DIR}/pi`,
    cloudSubpath: 'pi/',
    realShape: 'nonempty-json',
    // No `freshness`: Pi's auth.json holds API keys and OAuth blobs that it
    // refreshes in place without ROTATING a refresh token, so there is no
    // ordering field to compare and last-writer-wins is correct.
  },
  // Pi resolves a key as: --api-key flag -> auth.json -> env -> models.json.
  // Forwarding these lets an env-authed host work in a box with no auth.json.
  forwardedEnvKeys: [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
    'XAI_API_KEY',
    'GROQ_API_KEY',
    'AI_GATEWAY_API_KEY',
    'HF_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
  ],
  boxRunEnv: {
    // Suppress the startup update check only. Deliberately NOT `PI_OFFLINE=1`,
    // which also blocks the provider model-catalog fetch — a fresh box has no
    // `models-store.json` (we exclude the host's), so offline would leave it
    // with no model list at all.
    PI_SKIP_VERSION_CHECK: '1',
  },
  // Pi auto-loads every `.ts`/`.js` file under its `extensions/` dir
  // (`isExtensionFile` in its bundle accepts both), so a plain `.js` needs no
  // TypeScript toolchain in the box. This one subscribes to Pi's event bus and
  // shells `agentbox-ctl agent-state pi <state>` — the ONLY source of Pi
  // activity (`activitySource: ['plugin']`).
  seeds: [
    {
      bakedPath: PI_EXTENSION_PATH,
      destRel: 'extensions/agentbox-state.js',
      sharedAsset: 'pi-agentbox-extension.js',
      label: 'the agentbox-state extension',
    },
  ],
  // `-a` / `--approve` is Pi's PROJECT TRUST flag, not a permission bypass (Pi
  // has no tool-approval prompts at all — it is designed to run with full
  // permissions inside a container, which is what a box is). Without it, an
  // interactive launch into a repo carrying a `.pi/` dir blocks on a
  // "trust project-local files?" dialog that nothing on the host can answer.
  launchFlags: ['-a'],
  caps: {
    resume: true,
    teleport: 'full',
    activitySource: ['plugin'],
  },
  // Box->host: a flat list under the single config root. `sessions` is absent
  // on purpose — a box's transcripts are its own, and pulling them into the
  // host's per-cwd session tree would mix `/workspace` sessions into the
  // project's history.
  pull: {
    items: [
      {
        group: 'data',
        names: [
          'auth.json',
          'settings.json',
          'AGENTS.md',
          'SYSTEM.md',
          'APPEND_SYSTEM.md',
          'extensions',
          'skills',
          'prompts',
          'themes',
        ],
      },
    ],
  },
};
