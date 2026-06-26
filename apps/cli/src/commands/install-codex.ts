/**
 * `agentbox install codex` — register + install + **enable** the AgentBox Codex
 * plugin so the `agentbox` / `agentbox-info` skills are available in host Codex
 * with no manual toggle.
 *
 * Three steps, all best-effort (a Codex/network hiccup never aborts the parent
 * `agentbox install`):
 *   1. `codex plugin marketplace add madarco/agentbox`  → `[marketplaces.agentbox]`
 *   2. `codex plugin add agentbox@agentbox`             → downloads the bundle
 *   3. enable-by-default: append `[plugins."agentbox@agentbox"] enabled = true`
 *      to `~/.codex/config.toml`. Codex has no `plugin enable` CLI (only the TUI
 *      toggle, which writes this same key), and our marketplace policy is
 *      `AVAILABLE` (opt-in), so without this the plugin lands installed-but-off.
 *
 * The enable write is idempotent and never clobbers the user's file: we append a
 * delimited managed block ONLY when no `plugins."agentbox@agentbox"` table exists
 * yet. If the user/TUI already wrote that table (enabled or disabled), we respect
 * it and drop our managed block (a second table would be a TOML parse error).
 */

import { intro, log, note, outro } from '../lib/prompt.js';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/** GitHub marketplace source passed to `codex plugin marketplace add`. */
const MARKETPLACE_SOURCE = 'madarco/agentbox';
/** Marketplace name (from `.agents/plugins/marketplace.json`) and plugin name. */
const MARKETPLACE_NAME = 'agentbox';
const PLUGIN_NAME = 'agentbox';
/** Effective plugin id / config key: `<plugin>@<marketplace>`. */
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** `$CODEX_HOME` if set, else `~/.codex`. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CODEX_HOME'];
  return override && override.length > 0 ? override : join(homedir(), '.codex');
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHomeDir(env), 'config.toml');
}

/** The codex binary: `CODEX_BIN_PATH` override, else `codex` on PATH. */
function codexBinary(env: NodeJS.ProcessEnv = process.env): string {
  const b = env['CODEX_BIN_PATH'];
  return b && b.length > 0 ? b : 'codex';
}

function codexCliAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const r = spawnSync(codexBinary(env), ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * True when `agentbox@agentbox` is already installed. Used to skip the network
 * re-add on re-runs — `codex plugin add` re-enables a deliberately-disabled
 * plugin, so re-adding would silently override a user's choice. Treats any
 * error (old CLI, no network) as "not installed" so the add path still runs.
 */
function codexPluginInstalled(bin: string): boolean {
  try {
    const r = spawnSync(bin, ['plugin', 'list', '--json'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return false;
    const parsed = JSON.parse(r.stdout) as { installed?: { pluginId?: string }[] };
    return (parsed.installed ?? []).some((p) => p.pluginId === PLUGIN_ID);
  } catch {
    return false;
  }
}

/** The managed TOML block that enables the plugin by default. */
export function codexPluginEnableTable(): string {
  return `# AgentBox plugin (added by \`agentbox install codex\`). Set enabled = false to disable.
[plugins."${PLUGIN_ID}"]
enabled = true`;
}

export type CodexEnableStatus =
  | 'added' // appended the enable table (no prior entry)
  | 'forced-enabled' // --force flipped a disabled entry to enabled
  | 'user-enabled' // already enabled — left untouched
  | 'user-disabled' // explicitly disabled, no --force — respected
  | 'parse-error'; // config.toml didn't parse — left untouched

export interface CodexEnableResult {
  text: string;
  status: CodexEnableStatus;
}

/**
 * Ensure the plugin is enabled in a `config.toml` body. Pure + tested. The
 * `plugins."agentbox@agentbox"` table is owned by Codex (written by `plugin add`
 * / the TUI toggle), so we never write a second one: append the enable table
 * only when it's absent, otherwise respect the present value. `force` flips a
 * present `enabled = false` to true via a targeted in-place edit — the rest of
 * the file (comments, order, formatting) is preserved untouched.
 */
export function upsertCodexPluginEnable(
  existing: string,
  opts: { force?: boolean } = {},
): CodexEnableResult {
  let entry: { enabled?: unknown } | undefined;
  try {
    const parsed = parseToml(existing) as {
      plugins?: Record<string, { enabled?: unknown }>;
    };
    entry = parsed.plugins?.[PLUGIN_ID];
  } catch {
    // Malformed user config — don't risk making it worse.
    return { text: existing, status: 'parse-error' };
  }

  if (entry === undefined) {
    const head = existing.replace(/\s+$/, '');
    const text = (head.length > 0 ? `${head}\n\n` : '') + codexPluginEnableTable() + '\n';
    return { text, status: 'added' };
  }
  // Present: respect it. `enabled` defaults to true in Codex, so only an
  // explicit `false` counts as disabled.
  if (entry.enabled !== false) return { text: existing, status: 'user-enabled' };
  if (!opts.force) return { text: existing, status: 'user-disabled' };
  return { text: forceEnableInPlace(existing), status: 'forced-enabled' };
}

/**
 * Set `enabled = true` inside the existing `[plugins."agentbox@agentbox"]` table
 * without disturbing the rest of the file: rewrite the `enabled` line within the
 * table's section (its header → next table header / EOF), inserting one if the
 * table has no `enabled` key.
 */
function forceEnableInPlace(existing: string): string {
  const lines = existing.split('\n');
  const header = `[plugins."${PLUGIN_ID}"]`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return existing; // caller already confirmed presence
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  for (let i = start + 1; i < end; i++) {
    if (/^\s*enabled\s*=/.test(lines[i] ?? '')) {
      lines[i] = 'enabled = true';
      return lines.join('\n');
    }
  }
  lines.splice(start + 1, 0, 'enabled = true');
  return lines.join('\n');
}

export interface InstallCodexOptions {
  force?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
}

export interface InstallCodexResult {
  /** False when Codex isn't set up on this host (clean skip, not an error). */
  ran: boolean;
  marketplaceAdded: boolean;
  pluginInstalled: boolean;
  enableStatus?: CodexEnableStatus;
  configPath: string;
}

/**
 * Register + install + enable the AgentBox Codex plugin. Gated on the host
 * having Codex (`~/.codex` exists and the `codex` CLI is on PATH); otherwise a
 * clean no-op. Never throws on a Codex/network failure — returns what it managed
 * to do and logs hints.
 */
export async function installCodexPlugin(
  opts: InstallCodexOptions = {},
): Promise<InstallCodexResult> {
  const env = process.env;
  const cfgPath = codexConfigPath(env);
  const result: InstallCodexResult = {
    ran: false,
    marketplaceAdded: false,
    pluginInstalled: false,
    configPath: cfgPath,
  };

  // Gate: Codex must be set up on this host.
  if (!existsSync(codexHomeDir(env)) || !codexCliAvailable(env)) {
    return result;
  }
  result.ran = true;
  const bin = codexBinary(env);

  if (opts.dryRun) {
    if (!opts.quiet) {
      process.stdout.write(
        `# would run: ${bin} plugin marketplace add ${MARKETPLACE_SOURCE}\n` +
          `# would run: ${bin} plugin add ${PLUGIN_ID}\n` +
          `# --- appended to ${cfgPath} (only if not already configured) ---\n` +
          `${codexPluginEnableTable()}\n`,
      );
    }
    return result;
  }

  // Skip the network re-add when already installed (unless --force): a re-add
  // would re-enable a plugin the user deliberately disabled. The enable step
  // below still runs and respects their current choice.
  const alreadyInstalled = !opts.force && codexPluginInstalled(bin);
  if (alreadyInstalled) {
    result.marketplaceAdded = true;
    result.pluginInstalled = true;
  } else {
    // 1) Register the marketplace (idempotent upsert of [marketplaces.agentbox]).
    const mkt = spawnSync(bin, ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], {
      stdio: 'ignore',
    });
    result.marketplaceAdded = mkt.status === 0;

    // 2) Install the plugin bundle. Best-effort: a non-zero status is most often
    // "already installed"; surface only as a hint.
    const add = spawnSync(bin, ['plugin', 'add', PLUGIN_ID], { encoding: 'utf8' });
    result.pluginInstalled = add.status === 0;
    if (add.status !== 0 && !opts.quiet) {
      const detail = (add.stderr || add.stdout || '').trim();
      log.info(
        `codex plugin add ${PLUGIN_ID} returned non-zero (continuing — likely already installed)` +
          (detail ? `: ${detail.split('\n')[0]}` : ''),
      );
    }
  }

  // 3) Enable by default in config.toml (respecting an explicit user choice).
  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const { text, status } = upsertCodexPluginEnable(existing, { force: opts.force });
  result.enableStatus = status;
  if (text !== existing) {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, text);
  } else if (status === 'user-disabled' && !opts.quiet) {
    log.info(
      `AgentBox Codex plugin is present but disabled in ${cfgPath} — leaving it off. ` +
        `Re-run with --force (or set enabled = true) to use it.`,
    );
  }
  return result;
}

export const installCodexCommand = new Command('codex')
  .description(
    'Install + enable the AgentBox Codex plugin (marketplace add, plugin add, and enable it by default in ~/.codex/config.toml).',
  )
  .option('--dry-run', 'print the commands and config block without changing anything')
  .option('--force', 're-install and re-enable even if the plugin was disabled')
  .action(async (opts: { dryRun?: boolean; force?: boolean }) => {
    intro('AgentBox Codex plugin');
    const res = await installCodexPlugin({ force: opts.force, dryRun: opts.dryRun });
    if (!res.ran) {
      outro('Codex not detected on this host (no ~/.codex or `codex` CLI) — skipped.');
      return;
    }
    if (opts.dryRun) {
      outro('dry-run: nothing written');
      return;
    }
    note(
      `Marketplace: ${res.marketplaceAdded ? 'registered' : 'see warning above'}\n` +
        `Plugin:      ${res.pluginInstalled ? 'installed' : 'add attempted (may already exist)'}\n` +
        `Enabled:     ${
          res.enableStatus === 'added'
            ? `yes (wrote ${res.configPath})`
            : res.enableStatus === 'forced-enabled'
              ? `re-enabled (wrote ${res.configPath})`
              : res.enableStatus === 'user-enabled'
                ? 'already enabled'
                : res.enableStatus === 'user-disabled'
                  ? 'left disabled (your choice — re-run with --force to enable)'
                  : `could not edit ${res.configPath}`
        }`,
      'Installed',
    );
    outro('done — restart Codex if it was running');
  });
