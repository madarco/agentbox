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
import { buildCodexImportScript, codexImportMarker } from './_codex-import.js';

const PI_BOX_DIR = `${BOX_HOME}/.pi/agent`;
const PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * `npm install -g <pkg>@<pi.version>`, defaulting to `latest`.
 *
 * Exported for the test that runs it through a real shell: the guard is the
 * only thing between a config value and an npm argv.
 */
export function buildPiNpmInstall(pkg: string): string {
  // Exact semver or a dist-tag, nothing else: a range (`^0.70`, `1.x`) would
  // drift exactly like `latest`. The charset `case` runs first so a newline can
  // never let grep match one line of a multi-line value.
  const exact =
    '(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?';
  const tag = '[A-Za-z][A-Za-z0-9._-]*';
  return [
    'v="${AGENTBOX_AGENT_SETTING_VERSION:-latest}"',
    'case "$v" in ""|x|X|*[!0-9A-Za-z._+-]*) ok=0;; *) ok=1;; esac',
    `if [ "$ok" = 1 ] && printf "%s\\n" "$v" | grep -Eqx "${exact}|${tag}"; then :; else ` +
      'echo "agentbox: pi.version must be an exact version such as 0.70.2 or an npm dist-tag such as latest (got: $v)" >&2; exit 64; fi',
    `npm install -g "${pkg}@$v" 2>&1`,
  ].join('; ');
}
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
    //
    // `exec` rather than `{ kind: 'npm' }` only to read `pi.version` (exported
    // as AGENTBOX_AGENT_SETTING_VERSION at every install site — the derived
    // docker layer, each provider's bake, and `ensureAgentInstalled`). The
    // value is user config, so it must be an exact version or a dist-tag before
    // it reaches the command line, and is expanded inside double quotes so it
    // can never be more than one argument. Unset or empty means `latest`.
    recipe: { kind: 'exec', script: buildPiNpmInstall(PI_NPM_PACKAGE) },
    runAs: 'root',
    postInstall: [
      // Fail the INSTALL, not the launch, on too old a Node.
      //
      // Pi's package declares `engines: node >= 22.19.0` and uses `fs.globSync`
      // (node 22+), but `npm install -g` only WARNS on an engines mismatch. So
      // on a node-20 box the install "succeeds", `command -v pi` passes, the
      // box reports ready, and the tmux session dies instantly with
      // `SyntaxError: ... does not provide an export named 'globSync'` -- which
      // surfaces as "agent exited immediately after launch" with no cause.
      // Cost a full e2b create to diagnose; every provider's base is node 24
      // except E2B's, whose upstream `e2bdev/base` ships node 20.
      //
      // A community provider can hit this too and cannot patch our bake
      // scripts, so the check belongs on the agent that has the requirement.
      'if [ "$(node -p \'process.versions.node.split(".")[0]\' 2>/dev/null || echo 0)" -lt 22 ]; then ' +
        'echo "agentbox: pi needs Node >= 22.19, but this box has $(node --version 2>/dev/null || echo none). ' +
        'Re-bake this provider\'s base (agentbox prepare --provider <name>) to get a newer Node." >&2; exit 65; fi',
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
  // Session history (docs/agent-history-plan.md): one JSONL tree per session,
  // under a folder named after the session's cwd.
  history: {
    transcripts: [
      {
        root: 'sessions',
        format: 'json-tree',
        mode: 'append',
        sessionFiles: ['*/*_<sessionId>.jsonl'],
      },
    ],
  },
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
  // The hub's skills library: `--skill <dir>` adds a dir of skills to pi's own
  // discovery (measured, Phase 0). pi >= 0.84 warns "skill path does not exist"
  // on every launch when the dir is missing (0.73.1 did not), so both launchers
  // create it first (`agentLaunchPrelude`).
  skills: {
    dirs: ['.pi/agent/skills', '.agents/skills'],
    inject: { kind: 'flag', argv: ['--skill', '{dir}'] },
  },
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
    // Leaf FILES only. A directory whose children are the unit belongs in
    // `categories`, not here: the pull is additive and skips anything the host
    // already has, so listing `skills` flat would make every box-created skill
    // unpullable the moment the host had a `skills/` dir of its own.
    items: [
      {
        group: 'data',
        names: ['auth.json', 'settings.json', 'AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'],
      },
    ],
    // Directories of independent, individually-addable items — the same shape
    // as claude's skills/agents/commands.
    categories: ['extensions', 'skills', 'prompts', 'themes'],
  },
  // Multi-provider, so it can run on a Codex (ChatGPT) subscription the host
  // already holds. The import is a field mapping into its own store — see
  // `buildCodexImportScript` for what was measured to make that safe.
  modelAuth: {
    sources: [
      { kind: 'agent', agent: 'codex', label: 'Your Codex login (ChatGPT subscription OAuth)' },
    ],
    ingest: {
      kind: 'command',
      name: 'pi-model-auth',
      command: buildCodexImportScript({
        agentId: 'pi',
        storePath: `${PI_BOX_DIR}/auth.json`,
        providerKey: 'openai-codex',
        marker: codexImportMarker('pi'),
      }),
    },
  },
  settings: [
    {
      key: 'version',
      type: 'string',
      default: 'latest',
      description:
        'Which Pi release is installed into a box: an exact version (`0.70.2`) or npm dist-tag (`latest`); ranges such as `^0.70` are refused. Pin it so boxes stop drifting to whatever was newest at bake time. Bake-time - changing it re-derives the agent layer; a runtime install into an existing box reads it too.',
      // Two versions are two derived agent artifacts. The default folds to the
      // identity, so leaving it unset changes no existing fingerprint.
      affectsBake: true,
    },
    {
      key: 'modelAuth',
      type: 'enum-list',
      enumValues: ['none', 'codex'],
      default: 'none',
      description:
        'Which host model-provider logins a new pi box is seeded with, comma-separated. `codex` copies your Codex (ChatGPT) OAuth login into the box and imports it as `openai-codex`. `none` leaves model auth to the box, and is only valid on its own. `--model-auth` overrides per create.',
    },
  ],
};
