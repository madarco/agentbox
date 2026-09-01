/**
 * Claude Code's registry row — the DATA half of this package.
 *
 * Imports only the two dependency-free leaves (`@agentbox/core` for the
 * contract, `@agentbox/config` for the host state dir) on purpose: this entry is read by
 * the agent registry, which `sandbox-core` depends on, which in turn everything
 * depends on. Anything heavier here is a dependency cycle. See this package's
 * `tsup.config.ts`.
 */

import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';
import { BOX_USER, BOX_HOME, BOX_CREDS_DIR, SETUP_GUIDE_PATH } from '@agentbox/core';
import type { AgentSyncSpec } from '@agentbox/core';

const CLAUDE_BOX_DIR = `${BOX_HOME}/.claude`;

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
 * never fail an agent install. On docker the config volume mounts over this dir,
 * so the `seeds` declaration below re-places the same content into the volume —
 * harmless, identical bytes.
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

export const claudeSpec: AgentSyncSpec = {
  id: 'claude',
  aliases: ['claude-code'],
  wireId: 'claude-code',
  sessionName: 'claude',
  binary: 'claude',
  // Anthropic's native installer is the canonical path (code.claude.com/docs/en/setup)
  // and drops the binary at ~/.local/bin/claude, which is what the host's
  // `.claude.json` (installMethod=native) expects. The CDN intermittently 403s
  // cloud egress IPs under load, hence the retries. The npm package is a
  // BAKE-TIME-only fallback selected by `claude.install`, not a second recipe.
  install: {
    recipe: { kind: 'script', url: 'https://claude.ai/install.sh', retries: 3 },
    runAs: 'box-user',
    alternatesFrom: 'install',
    // ~/.claude must exist and be box-user-owned BEFORE the named config
    // volume mounts over it: docker seeds an empty volume's permissions from
    // the mount point, so without this the volume comes up root-owned and
    // Claude Code can't write. The two symlinks are deliberately dangling at
    // build time — `_claude.json` materialises when the volume is seeded, and
    // `.credentials.json` resolves once the cloud credential volume mounts.
    postInstall: [
      `install -d -o ${BOX_USER} -g ${BOX_USER} ${CLAUDE_BOX_DIR} ${BOX_CREDS_DIR}/claude`,
      `ln -sfn ${CLAUDE_BOX_DIR}/_claude.json ${BOX_HOME}/.claude.json`,
      `ln -sfn ${BOX_CREDS_DIR}/claude/.credentials.json ${CLAUDE_BOX_DIR}/.credentials.json`,
      `chown -R ${BOX_USER}:${BOX_USER} ${BOX_CREDS_DIR}`,
      `chown -h ${BOX_USER}:${BOX_USER} ${BOX_HOME}/.claude.json ${CLAUDE_BOX_DIR}/.credentials.json`,
      SEED_SETUP_SKILL,
    ].join(' && '),
    alternates: {
      // `claude.install: npm`. npm-global drops `claude` at Node's prefix
      // bin; symlink it into ~/.local/bin so the box is indistinguishable
      // from a native install (the host's .claude.json says installMethod
      // native, and the in-box integrity check compares against that).
      npm: {
        recipe: { kind: 'npm', package: '@anthropic-ai/claude-code' },
        runAs: 'root',
        postInstall: [
          `install -d -o ${BOX_USER} -g ${BOX_USER} ${BOX_HOME}/.local/bin ${CLAUDE_BOX_DIR} ${BOX_CREDS_DIR}/claude`,
          `ln -sf "$(command -v claude)" ${BOX_HOME}/.local/bin/claude`,
          `ln -sfn ${CLAUDE_BOX_DIR}/_claude.json ${BOX_HOME}/.claude.json`,
          `ln -sfn ${BOX_CREDS_DIR}/claude/.credentials.json ${CLAUDE_BOX_DIR}/.credentials.json`,
          `chown -R ${BOX_USER}:${BOX_USER} ${BOX_CREDS_DIR}`,
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
  // Claude Code's own renderer overrides. See `AgentSyncSpec.tuiEnv` for why
  // this is data: it replaced a `binary === 'claude'` branch at each cloud
  // launch site. `auto` is present and empty on purpose — "no override, Claude
  // Code decides" is a real mode, not a missing entry.
  tuiEnv: {
    default: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
    fullscreen: { CLAUDE_CODE_NO_FLICKER: '1' },
    auto: {},
  },
  tuiEnvFrom: 'tui',
  // Claude's own settings. These stay CLAUDE-named because they genuinely are:
  // one picks between Anthropic's installer and the npm package, the other
  // between Claude Code's two renderers. What is generic is the mechanism —
  // config generates `claude.install` / `claude.tui` from these rows, and the
  // values reach this spec's `alternates` / `tuiEnv` and the install shell's
  // `AGENTBOX_AGENT_SETTING_*` env without any shared code knowing what they
  // mean.
  settings: [
    {
      key: 'install',
      type: 'enum',
      enumValues: ['native', 'npm'],
      default: 'native',
      description:
        "How Claude Code is installed into a box image: `native` runs Anthropic's installer (the recommended path), `npm` installs @anthropic-ai/claude-code. Use `npm` on hosts whose egress IP the native CDN 403s. Bake-time - changing it re-derives the agent layer.",
      // Two values are two derived agent artifacts. The AGENTLESS base is
      // unaffected: it installs no agent, so it must not fork on this.
      affectsBake: true,
    },
    {
      key: 'tui',
      type: 'enum',
      enumValues: ['default', 'fullscreen', 'auto'],
      default: 'default',
      description:
        "Terminal renderer Claude Code uses inside a box. Claude's `fullscreen` renderer repaints differentially and leaves stale characters in the blank areas of the screen over a network transport - visible while scrolling, cleared only by resizing the terminal. Boxes pin the classic renderer; set `fullscreen` to opt back in, or `auto` to let Claude decide. Rides the launch, so it takes effect on the agent's next start.",
      // Deliberately NOT affectsBake: it is launch env, and folding it would
      // re-bake a whole base image for a renderer flip.
    },
  ],
  // The box-ONLY wizard skill: deliberately never written to the host's
  // ~/.claude. Claude also gets it at install time via SEED_SETUP_SKILL, but
  // the docker config volume mounts OVER ~/.claude, so it has to be re-placed
  // into the volume as well — same bytes, two placements.
  seeds: [
    {
      bakedPath: SETUP_GUIDE_PATH,
      destRel: 'skills/agentbox-setup/SKILL.md',
      sharedAsset: 'agentbox-setup-skill.md',
      label: 'the /agentbox-setup skill',
    },
  ],
  caps: { resume: true, teleport: 'full', activitySource: ['hooks', 'scraper'] },
  // Box->host. Claude's unit is a CHILD of a category dir, plus a 2-level
  // plugin cache, plus two registry JSONs merged additively with a
  // container->host path rewrite. See AgentPullSpec.
  pull: {
    categories: ['skills', 'agents', 'commands'],
    jsonMerges: [
      { rel: 'plugins/installed_plugins.json', projection: 'plugins' },
      { rel: 'plugins/known_marketplaces.json', projection: 'root' },
    ],
  },
};
