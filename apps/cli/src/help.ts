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
    commands: ['dashboard', 'url', 'screen', 'code', 'shell', 'open', 'logs', 'drive'],
  },
  { title: 'Inspect', commands: ['list', 'status', 'top', 'agent'] },
  { title: 'Lifecycle', commands: ['start', 'stop', 'destroy', 'pause', 'unpause'] },
  { title: 'Sync & state', commands: ['download', 'cp', 'checkpoint', 'queue'] },
  {
    title: 'Advanced',
    commands: [
      'prepare',
      'wait',
      'prune',
      'self-update',
      'install',
      'config',
      'relay',
      'docker',
      'daytona',
      'hetzner',
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
