/**
 * `agentbox install codex` — the command shim.
 *
 * Everything it does lives in `@agentbox/agent-codex` (`installCodexPlugin` and
 * the `~/.codex/config.toml` enable-table helpers). What stays here is the
 * commander wiring and the one thing the package must not do for itself: find
 * the user's source checkout, which is the CLI's own business.
 */
import { Command } from 'commander';
import { intro, note, outro } from '@agentbox/cli-kit';
import { installCodexPlugin } from '@agentbox/agent-codex/cli';
import { resolveDevRepoRoot } from '../lib/source-checkout.js';

export const installCodexCommand = new Command('codex')
  .description(
    'Install + enable the AgentBox Codex plugin (marketplace add, plugin add, and enable it by default in ~/.codex/config.toml).',
  )
  .option('--dry-run', 'print the commands and config block without changing anything')
  .option('--force', 're-install and re-enable even if the plugin was disabled')
  .option('--no-dev', 'use the published GitHub marketplace even inside a source checkout')
  .action(async (opts: { dryRun?: boolean; force?: boolean; dev?: boolean }) => {
    intro('AgentBox Codex plugin');
    // commander negatable flag: `--no-dev` sets opts.dev === false.
    const res = await installCodexPlugin({
      force: opts.force,
      dryRun: opts.dryRun,
      noDev: opts.dev === false,
      resolveDevRepoRoot,
    });
    if (!res.ran) {
      outro('Codex not detected on this host (no ~/.codex or `codex` CLI) — skipped.');
      return;
    }
    if (opts.dryRun) {
      outro('dry-run: nothing written');
      return;
    }
    note(
      `Source:      ${
        res.dev
          ? `local repo (dev)${res.skillsSymlinked ? ', skill symlinked — edits live on restart' : ''}`
          : 'madarco/agentbox (GitHub)'
      }\n` +
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
