/**
 * Codex's registry row — the DATA half of this package.
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

const CODEX_BOX_DIR = `${BOX_HOME}/.codex`;
/** Baked alongside the setup guide: codex's activity-reporting hooks. */
const CODEX_HOOKS_PATH = '/usr/local/share/agentbox/codex-hooks.json';

export const codexSpec: AgentSyncSpec = {
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
      ...agentDirPrelude([CODEX_BOX_DIR], 'codex'),
      `ln -sfn ${BOX_CREDS_DIR}/codex/auth.json ${CODEX_BOX_DIR}/auth.json`,
      `chown -h ${BOX_USER}:${BOX_USER} ${CODEX_BOX_DIR}/auth.json`,
    ].join(' && '),
  },
  dockerVolume: 'agentbox-codex-config',
  staticPaths: [
    {
      hostHomeRel: ['.codex'],
      boxDir: CODEX_BOX_DIR,
      // Push excludes (single source of truth; consumed by
      // `agentPushExcludes`, which also derives the credential file and applies
      // LIVE_DATABASE_EXCLUDES — so the `*.sqlite*` families no longer need
      // naming here, and cannot go stale again as codex adds databases).
      // `state_*.sqlite*` is the resume-cwd index (rebuilt in-box);
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
        'sessions',
        'log',
        'history.jsonl',
        'hooks.json',
        'external_agent_session_imports.json',
        // The DIRECTORY, not a database pattern: `LIVE_DATABASE_EXCLUDES`
        // matches file names, so dropping this would still ship the empty dir.
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
  // Codex auto-discovers `~/.codex/hooks.json` and accumulates its hooks with
  // any the user defined, so seeding this never disables the user's own.
  seeds: [
    {
      bakedPath: CODEX_HOOKS_PATH,
      destRel: 'hooks.json',
      sharedAsset: 'agentbox-codex-hooks.json',
      label: 'Codex activity hooks',
    },
  ],
  // Codex will not load the seeded hooks without these:
  // - `--enable hooks` opts into lifecycle-hook loading (the feature was
  //   renamed `codex_hooks` -> `hooks` in 0.134.0).
  // - `--dangerously-bypass-hook-trust` skips the in-TUI "trust these hooks?"
  //   dialog that would otherwise block startup on every fresh box. The hooks
  //   are AgentBox-managed and pre-vetted; the user never sees them.
  // The flag makes codex print a cosmetic "…is enabled" warning at startup and
  // there is NO option to silence just that one. Persisting trust hashes in
  // config.toml instead is worse: the hash is an opaque codex-internal digest
  // tied to both the file content and the codex version, and a mismatch turns
  // the cosmetic warning into a *blocking* "Hooks need review" dialog.
  launchFlags: ['--enable', 'hooks', '--dangerously-bypass-hook-trust'],
  caps: { resume: true, teleport: 'full', activitySource: ['hooks', 'scraper'] },
  // Box->host: a flat list under the single config root.
  pull: { items: [{ group: 'data', names: ['config.toml', 'auth.json', 'prompts'] }] },
};
