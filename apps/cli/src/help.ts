import type { Command } from 'commander';

// Ordered command groups for the top-level `agentbox --help`. commander@12.1.0
// has no native .helpGroup(); we suppress the flat Commands: list via
// configureHelp({ visibleCommands: () => [] }) and render this instead.
// Names must match the registered Command names in index.ts — the drift test
// in test/commands.test.ts asserts this map covers every top-level command.
export interface HelpGroup {
  title: string;
  hint?: string;
  commands: string[];
}

export const HELP_GROUPS: HelpGroup[] = [
  { title: 'Create & run', commands: ['create', 'claude', 'fork', 'codex', 'opencode'] },
  {
    title: 'Access',
    commands: ['dashboard', 'attach', 'url', 'screen', 'code', 'shell', 'open', 'logs', 'drive'],
  },
  { title: 'Inspect', commands: ['list', 'status', 'services', 'top', 'agent'] },
  { title: 'Lifecycle', commands: ['start', 'stop', 'destroy', 'pause', 'unpause', 'recover'] },
  { title: 'Sync & state', commands: ['download', 'cp', 'checkpoint', 'queue'] },
  {
    title: 'Advanced',
    commands: [
      'prepare',
      'wait',
      'prune',
      'doctor',
      'self-update',
      'install',
      'plugin',
      'app',
      'config',
      'git',
      'inbound',
      'connect',
      'relay',
      'hub',
      'docker',
      'daytona',
      'hetzner',
      'vercel',
      'e2b',
      'digitalocean',
    ],
  },
];

function term(cmd: Command): string {
  const aliases = cmd.aliases();
  return aliases.length ? `${cmd.name()}|${aliases.join('|')}` : cmd.name();
}

/**
 * True when a command was registered with `program.addCommand(cmd, { hidden: true })`.
 * commander v12 stores this on the private `_hidden` property; the cast keeps
 * the lint clean without exposing commander internals across the codebase.
 */
function isHiddenCommand(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

// Builds the grouped Commands: block. Descriptions/aliases come straight from
// the registered Command objects so help text never drifts from the source.
// Hidden commands (`addCommand(cmd, { hidden: true })`) are excluded — that's
// how internal-only commands like `_run-queued-job` stay out of help. Any
// registered visible command missing from HELP_GROUPS lands in a trailing
// "Other" group (fail-soft — the drift test fails if this is non-empty).
export function buildGroupedHelp(program: Command): string {
  const visible = program.commands.filter((c) => !isHiddenCommand(c));
  const byName = new Map(visible.map((c) => [c.name(), c] as const));
  const grouped = new Set(HELP_GROUPS.flatMap((g) => g.commands));
  const orphans = visible.map((c) => c.name()).filter((n) => !grouped.has(n));

  const groups: HelpGroup[] = [...HELP_GROUPS];
  if (orphans.length) groups.push({ title: 'Other', commands: orphans });

  const terms: string[] = [];
  for (const g of groups) {
    for (const name of g.commands) {
      const cmd = byName.get(name);
      if (cmd) terms.push(term(cmd));
    }
  }
  const pad = Math.max(0, ...terms.map((t) => t.length)) + 2;

  const lines: string[] = ['Commands:'];
  for (const g of groups) {
    const title = g.hint ? `${g.title}  (${g.hint})` : g.title;
    lines.push('', `  ${title}`);
    for (const name of g.commands) {
      const cmd = byName.get(name);
      if (!cmd) continue;
      lines.push(`    ${term(cmd).padEnd(pad)}${cmd.description()}`);
    }
  }
  lines.push('', 'Run `agentbox <command> --help` for command-specific options.');
  return lines.join('\n');
}

// Compact view rendered by the default `agentbox --help`: only the core
// start → attach → git flow → destroy workflow, with related commands
// aggregated onto one line. Everything else lives in `agentbox help --all`
// (which renders HELP_GROUPS above). Aggregated rows need an explicit
// description since no single command's live description fits; single-command
// rows may override an overly long live description.
export interface CompactRow {
  commands: string[];
  /** Left column; defaults to the names joined with `|` (single command: name|aliases). */
  term?: string;
  /** Required when commands.length > 1; single-command rows default to the live description. */
  description?: string;
}

export interface CompactGroup {
  title: string;
  rows: CompactRow[];
}

export const COMPACT_HELP: CompactGroup[] = [
  {
    title: 'Run an agent',
    rows: [
      {
        commands: ['claude', 'codex', 'opencode'],
        description: 'Start the agent in a new isolated box',
      },
    ],
  },
  {
    title: 'Work with boxes',
    rows: [
      { commands: ['attach'], description: "Re-attach to a box's agent session" },
      { commands: ['list'], description: 'List agent boxes (-g for all projects)' },
      {
        commands: ['url', 'screen', 'open', 'code'],
        description: "Open a box's web app, VNC, files, or editor",
      },
      { commands: ['destroy'], description: 'Destroy a box' },
    ],
  },
  {
    title: 'Git',
    rows: [
      {
        commands: ['git'],
        term: 'git push|pull|pr',
        description: 'Push box commits to the host, pull host changes into the box, open PRs',
      },
    ],
  },
];

const COMPACT_EXAMPLE = [
  'Example:',
  '  agentbox claude        # start Claude Code in a new box',
  '  agentbox attach        # re-attach to its session',
  '  agentbox git push      # push the box\'s commits to your host repo',
  '  agentbox destroy       # remove the box',
];

const COMPACT_FOOTER = [
  'Run `agentbox <command> --help` for command options.',
  'More in `agentbox help --all`: claude|codex|opencode-specific commands, drive|queue,',
  'connect|download|services|inbound, lifecycle (pause|stop|checkpoint), providers, config, …',
];

export function buildCompactHelp(program: Command): string {
  const byName = new Map(program.commands.map((c) => [c.name(), c] as const));

  const rowTerm = (row: CompactRow): string => {
    if (row.term) return row.term;
    if (row.commands.length === 1) {
      const cmd = byName.get(row.commands[0]!);
      if (cmd) return term(cmd);
    }
    return row.commands.join('|');
  };

  const allTerms = COMPACT_HELP.flatMap((g) => g.rows.map(rowTerm));
  const pad = Math.max(0, ...allTerms.map((t) => t.length)) + 3;

  const lines: string[] = ['Commands:'];
  for (const g of COMPACT_HELP) {
    lines.push('', `  ${g.title}`);
    for (const row of g.rows) {
      const cmd = byName.get(row.commands[0]!);
      const description = row.description ?? cmd?.description() ?? '';
      lines.push(`    ${rowTerm(row).padEnd(pad)}${description}`);
    }
  }
  lines.push('', ...COMPACT_EXAMPLE, '', ...COMPACT_FOOTER);
  return lines.join('\n');
}
