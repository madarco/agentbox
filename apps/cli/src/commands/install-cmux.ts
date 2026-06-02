/**
 * `agentbox install cmux` — write an AgentBox panel into the cmux custom dock.
 *
 * cmux (https://cmux.com) renders a right-sidebar "dock" whose controls are
 * each a shell command shown in a Ghostty-backed terminal section, declared in
 * JSON at `~/.config/cmux/dock.json` (personal, always active) — see
 * https://cmux.com/docs/dock. We upsert a single control with `id: 'agentbox'`
 * that runs `agentbox list --cmux --watch` (compact, sidebar-tuned format), so
 * the live box list is pinned in the sidebar. Sibling controls (lazygit, logs,
 * …) are preserved untouched.
 *
 * The dock schema has no checkbox/widget primitive, so the project-vs-global
 * scope toggle lives *inside* the live list view: pressing `g` in
 * `agentbox list --watch` flips the scope (see list.ts / watch.ts). `--global`
 * here only bakes the panel's *initial* scope.
 *
 * This is intentionally a subcommand namespace (`install cmux`) so future cmux
 * settings can hang off it.
 *
 * Note: Dock is a cmux *beta* feature, off by default. Writing dock.json is
 * necessary but not sufficient — the user must enable it under cmux Settings ->
 * Beta features -> Dock, then switch the right sidebar to the Dock tab. We can't
 * flip that toggle from the CLI, so the success note spells it out.
 */

import { intro, log, note, outro } from '@clack/prompts';
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Stable id for the control we own; re-runs update it in place. */
const CONTROL_ID = 'agentbox';

/** A single cmux dock control. Extra keys on existing controls are preserved. */
interface DockControl {
  id: string;
  title?: string;
  command?: string;
  cwd?: string;
  height?: number;
  env?: Record<string, string>;
  [k: string]: unknown;
}

interface DockDoc {
  controls: DockControl[];
  [k: string]: unknown;
}

/**
 * Path to the cmux global dock config. cmux reads `~/.config/cmux/dock.json`,
 * honoring `$XDG_CONFIG_HOME` when set (standard XDG base-dir behavior).
 */
export function cmuxDockPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'cmux', 'dock.json');
}

export interface AgentboxControlOptions {
  command: string;
  title: string;
  height: number;
}

/**
 * Return a new dock doc with the `agentbox` control upserted: updated in place
 * (preserving its position and any extra keys) when present, else appended.
 * Sibling controls are left untouched. Pure — does no I/O.
 */
export function upsertAgentboxControl(doc: DockDoc, opts: AgentboxControlOptions): DockDoc {
  const controls = Array.isArray(doc.controls) ? doc.controls : [];
  const next: DockControl = {
    id: CONTROL_ID,
    title: opts.title,
    command: opts.command,
    height: opts.height,
  };
  const idx = controls.findIndex((c) => c && c.id === CONTROL_ID);
  const merged =
    idx >= 0
      ? controls.map((c, i) => (i === idx ? { ...c, ...next } : c))
      : [...controls, next];
  return { ...doc, controls: merged };
}

interface InstallCmuxOptions {
  global?: boolean;
  height?: string;
  title?: string;
  dryRun?: boolean;
  force?: boolean;
}

/** Parse `--height`, falling back to the default on a non-positive/NaN value. */
function parseHeight(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 320;
  return Math.round(n);
}

export const installCmuxCommand = new Command('cmux')
  .description(
    'Add an AgentBox panel to the cmux sidebar dock (~/.config/cmux/dock.json) showing the live box list. Press `g` in the panel to toggle all-projects scope.',
  )
  .option('-g, --global', "start the panel in all-projects scope (`agentbox list -g`)")
  .option('--height <points>', 'panel height in points', '320')
  .option('--title <text>', 'panel title shown in the dock header', 'AgentBox')
  .option('--dry-run', 'print the resulting dock.json without writing it')
  .option('--force', 'reset a dock.json that fails to parse (backed up to dock.json.bak)')
  .action((opts: InstallCmuxOptions) => {
    const dockPath = cmuxDockPath();
    // `--cmux` renders the compact sidebar view; `--watch` keeps it live.
    const command = `agentbox list${opts.global ? ' -g' : ''} --cmux --watch`;
    const controlOpts: AgentboxControlOptions = {
      command,
      title: opts.title ?? 'AgentBox',
      height: parseHeight(opts.height),
    };

    let doc: DockDoc = { controls: [] };
    if (existsSync(dockPath)) {
      const raw = readFileSync(dockPath, 'utf8');
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') doc = parsed as DockDoc;
      } catch {
        if (!opts.force) {
          log.error(
            `existing dock config is not valid JSON: ${dockPath}\n` +
              'fix it by hand, or pass --force to back it up and write a fresh one',
          );
          process.exit(1);
        }
        if (!opts.dryRun) {
          renameSync(dockPath, dockPath + '.bak');
          log.warn(`backed up unparseable dock config to ${dockPath}.bak`);
        }
        doc = { controls: [] };
      }
    }

    const updated = upsertAgentboxControl(doc, controlOpts);
    const json = JSON.stringify(updated, null, 2) + '\n';

    if (opts.dryRun) {
      intro('agentbox install cmux (dry run)');
      process.stdout.write(json);
      outro(`would write ${dockPath}`);
      return;
    }

    mkdirSync(dirname(dockPath), { recursive: true });
    writeFileSync(dockPath, json);

    intro('AgentBox cmux dock panel');
    note(
      `Wrote ${dockPath}\n` +
        `Panel command: ${command}\n\n` +
        'To see it:\n' +
        '  1. Enable Dock in cmux Settings -> Beta features -> Dock (it is off by default).\n' +
        '  2. Open the right sidebar and switch it to the Dock tab.\n\n' +
        'In the panel, press `g` to toggle all-projects scope.',
      'Installed',
    );
    outro('done');
  });
