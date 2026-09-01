import { agentPushExcludes } from '@agentbox/core';
/**
 * Codex's host-side staging — the part that is more than a copy.
 *
 * It sanitizes `config.toml`'s host-only entries (desktop-Codex MCP servers
 * pointing at macOS paths) and purges marketplace caches the sanitize orphaned.
 * Neither is expressible as `staticPaths` data, which is why codex supplies its
 * own stager instead of riding the generic one.
 *
 * Here rather than in `sandbox-core` because it is codex's, and `sandbox-core`
 * cannot import an agent package. `stageAllAgentStatic` reaches it through
 * `AgentCloudModule.stageStatic`; the rsync/tar primitives come from
 * `sandbox-core`.
 */

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  emptyResult,
  findBrokenSymlinks,
  makeCleanup,
  mkStageDir,
  pathExists,
  resolveAgentSpec,
  STAGE_WRITABLE_CHMOD,
  stageSingleFileTarball,
  tarballFromDir,
  type StageResult,
} from '@agentbox/sandbox-core';
import { sanitizeCodexConfigForBox } from './box-config.js';

// ---------- codex ----------

export interface StageCodexOptions {
  hostHome?: string;
}

// Registry data (single source of truth, drift-guarded by the registry test).
// Bare patterns mapped to `--exclude=` at the rsync call. Highlights: the
// `state_*.sqlite*` threads index is the resume-cwd source (rebuilt in-box from
// rollouts, so seeding it would trap a teleported session at the host cwd);
// `packages`/`plugins/.plugin-appserver`/`computer-use` are heavy macOS-only
// artifacts that balloon the staged tarball (~800 MB → ~0.5 MB).
const CODEX_STATIC_EXCLUDES = ((): readonly string[] => {
  const spec = resolveAgentSpec('codex');
  const path = spec.staticPaths[0];
  return path ? agentPushExcludes(spec, path, 'snapshot') : [];
})();
// `--include` carve-ins (the `.tmp/marketplaces/` snapshots) — must be emitted
// before the excludes; see the registry's codex spec for the rationale.
const CODEX_STATIC_INCLUDES = resolveAgentSpec('codex').staticPaths[0]?.include ?? [];

const CODEX_KEYCHAIN_WARNING =
  'codex: ~/.codex/auth.json missing. On macOS the codex CLI defaults to ' +
  "storing the OAuth token in the system Keychain, which isn't reachable " +
  'from a remote sandbox. To share creds with cloud boxes either:\n' +
  '  - add `cli_auth_credentials_store = "file"` to ~/.codex/config.toml ' +
  'then re-run `codex login`, or\n' +
  '  - set OPENAI_API_KEY in your environment, or\n' +
  '  - run `codex login --with-api-key` for a file-backed login.\n' +
  'Skipping codex seed; in-box codex will prompt for sign-in.';

/**
 * Filtered tarball of `~/.codex/` **excluding** `auth.json`. Extracts into
 * `/home/vscode/.codex/` on the sandbox FS at snapshot-bake time.
 *
 * `-L` dereferences EVERY symlink (codex sprouts links into `~/.nvm` for the
 * `applypatch` argv0 trick and into `~/.agents/skills/*`); produces a
 * symlink-free archive suitable for the FUSE-backed Daytona volume and the
 * sandbox FS alike. Broken symlinks would abort rsync under `-L`, so pre-scan
 * and skip them.
 */
/**
 * Best-effort, in-place sanitize of a staged `config.toml`: drops host-only-path
 * `mcp_servers` / `notify` / local marketplaces via {@link
 * sanitizeCodexConfigForBox}. A missing file, a parse failure, or any IO error
 * leaves the file untouched — staging must never fail on config sanitization.
 *
 * Returns the marketplace names kept in the sanitized config (the keep-set for
 * {@link purgeOrphanCodexMarketplaceDirs}); a missing config keeps nothing, and
 * `null` signals "unknown" (parse/IO failure) so the caller skips the purge —
 * never delete on unknown.
 */
async function sanitizeStagedCodexConfig(
  configPath: string,
  hostHome: string,
): Promise<{ keptMarketplaces: string[] } | null> {
  try {
    if (!(await pathExists(configPath))) return { keptMarketplaces: [] };
    const { text, changed, keptMarketplaces } = sanitizeCodexConfigForBox(
      await readFile(configPath, 'utf8'),
      hostHome,
    );
    if (changed) await writeFile(configPath, text);
    return { keptMarketplaces };
  } catch {
    // leave the rsynced copy as-is
    return null;
  }
}

/**
 * Delete staged marketplace artifacts whose marketplace is absent from the
 * sanitized config: `plugins/cache/<name>` (installed-plugin payloads — the
 * host's desktop-app caches carry macOS junk like native-prebuild
 * node_modules) and `.tmp/marketplaces/<name>` (snapshot checkouts, incl.
 * codex's transient `.staging`). Best-effort; missing dirs are fine.
 */
async function purgeOrphanCodexMarketplaceDirs(
  stageDir: string,
  keptMarketplaces: string[],
): Promise<void> {
  const kept = new Set(keptMarketplaces);
  for (const rel of ['plugins/cache', '.tmp/marketplaces']) {
    const dir = join(stageDir, rel);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // dir absent — nothing staged for it
    }
    for (const name of entries) {
      if (kept.has(name)) continue;
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}

export async function stageCodexStaticForUpload(
  opts: StageCodexOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  const hostCodex = join(hostHome, '.codex');
  if (!(await pathExists(hostCodex))) return emptyResult();

  const stageDir = await mkStageDir('codex-static');
  let tarballPath: string | null = null;
  try {
    const codexBroken = await findBrokenSymlinks(hostCodex);
    // Rule order matters (first-match-wins): broken-symlink excludes first
    // (exact anchored paths — a broken symlink inside a marketplace checkout
    // would abort the `-L` rsync if the includes matched it first), then the
    // `.tmp/marketplaces` includes, then the static excludes.
    await execa('rsync', [
      '-a',
      STAGE_WRITABLE_CHMOD,
      '-L',
      ...codexBroken.map((r) => `--exclude=/${r}`),
      ...CODEX_STATIC_INCLUDES.map((p) => `--include=${p}`),
      ...CODEX_STATIC_EXCLUDES.map((p) => `--exclude=${p}`),
      `${hostCodex}/`,
      `${stageDir}/`,
    ]);
    // Strip host-only-path entries (desktop-Codex.app MCP servers like
    // node_repl, a macOS notify helper, local-source marketplaces) from the
    // staged config.toml so the in-box codex doesn't try to exec macOS paths.
    // Best-effort: a parse failure leaves the rsynced copy intact.
    const sanitized = await sanitizeStagedCodexConfig(join(stageDir, 'config.toml'), hostHome);
    // Drop caches/snapshots of marketplaces the sanitize removed (or that no
    // config references). Skipped when the keep-set is unknown (sanitize
    // failure) — never delete on unknown.
    if (sanitized !== null) {
      await purgeOrphanCodexMarketplaceDirs(stageDir, sanitized.keptMarketplaces);
    }
    tarballPath = await tarballFromDir(stageDir, 'codex-static');
    return {
      tarballPath,
      cleanup: makeCleanup([stageDir, tarballPath]),
      warnings: [],
    };
  } catch (err) {
    await rm(stageDir, { recursive: true, force: true });
    if (tarballPath) await rm(tarballPath, { force: true });
    throw err;
  }
}

// ---------- agents (shared ~/.agents skills) ----------

/**
 * Tarball with **only** `auth.json`. Prefers the cloud backup
 * `~/.agentbox/codex-credentials.json` (a login captured from a previous cloud
 * box by `extractCloudAgentCredentials`); falls back to the host's real
 * `~/.codex/auth.json` so a fresh project still bootstraps from a host login.
 * Surfaces the macOS Keychain landmine as a warning when neither exists — see
 * `CODEX_KEYCHAIN_WARNING`.
 */
export async function stageCodexCredentialsForUpload(
  opts: StageCodexOptions = {},
): Promise<StageResult> {
  const hostHome = opts.hostHome ?? homedir();
  // Prefer the cloud backup under <hostHome>/.agentbox. Derive it from hostHome
  // (rather than the module-load `CODEX_CREDENTIALS_BACKUP_FILE` constant) so the
  // path tracks the active home: production uses the real home — identical to the
  // constant — while tests/callers can redirect the whole lookup via hostHome.
  const cloudBackup = join(hostHome, '.agentbox', 'codex-credentials.json');
  if (await pathExists(cloudBackup)) {
    return stageSingleFileTarball('codex-creds', cloudBackup, 'auth.json');
  }
  const hostAuth = join(hostHome, '.codex', 'auth.json');
  if (!(await pathExists(hostAuth))) return emptyResult([CODEX_KEYCHAIN_WARNING]);
  return stageSingleFileTarball('codex-creds', hostAuth, 'auth.json');
}
