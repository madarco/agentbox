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

// A `parent sub` entry (e.g. 'git push') renders that subcommand as a nested
// row under its parent — only the parent name must exist at the top level.
export const HELP_GROUPS: HelpGroup[] = [
  {
    title: 'Create & run',
    commands: ['create', 'attach', 'fork', 'claude', 'codex', 'opencode'],
  },
  {
    title: 'Access',
    commands: ['dashboard', 'url', 'screen', 'code', 'shell', 'open', 'logs', 'drive'],
  },
  { title: 'Inspect', commands: ['list', 'status', 'services', 'top', 'agent'] },
  { title: 'Lifecycle', commands: ['start', 'stop', 'destroy', 'pause', 'unpause', 'recover'] },
  {
    title: 'Git & sync',
    commands: ['git', 'git push', 'git pull', 'git pr', 'download', 'cp', 'checkpoint', 'queue'],
  },
  {
    title: 'Providers',
    commands: [
      'prepare',
      'docker',
      'daytona',
      'hetzner',
      'vercel',
      'e2b',
      'digitalocean',
      'remote-docker',
      'plugin',
      'inbound',
      'connect',
    ],
  },
  {
    title: 'Advanced',
    commands: [
      'wait',
      'prune',
      'doctor',
      'self-update',
      'install',
      'app',
      'config',
      'relay',
      'hub',
    ],
  },
];

// Short one-line descriptions for the grouped `agentbox help` list. The
// commands' own (often multi-sentence) descriptions stay untouched — they
// still render in full on `agentbox <command> --help`. Only commands whose
// live description would wrap need an entry; buildGroupedHelp falls back to
// the live description and clips as a safety net either way.
export const SHORT_DESCRIPTIONS: Record<string, string> = {
  create: 'Create and start a new agent box (no agent launched)',
  claude: 'Create a box and launch Claude Code (detachable tmux session)',
  codex: 'Create a box and launch OpenAI Codex (detachable tmux session)',
  opencode: 'Create a box and launch OpenCode (detachable tmux session)',
  fork: 'Fork the current host agent session into a new box and resume it there',
  attach: 'Attach to the running agent tmux session in a box',
  url: "Open a box's web app URL in the browser",
  shell: 'Open an interactive shell in a box (detachable tmux session)',
  open: 'Mount a box /workspace in Finder (sshfs), or open it in a host app',
  drive: 'Drive a box tmux session: snapshot screen, send keys, wait for output',
  top: 'Live resource monitor (cpu/mem/disk) for a box, project, or all boxes',
  agent: "Query and wait on the in-box coding agent's state",
  start: 'Start a stopped box',
  stop: 'Stop a box (disk preserved)',
  destroy: 'Destroy a box and discard its writable layer',
  pause: 'Pause a box (docker cgroup freeze / cloud archive)',
  unpause: 'Resume a paused box',
  recover: 'Reconnect to an already-running box without power-cycling it',
  download: "Download a box's /workspace back to the host (gitignore-aware)",
  cp: 'Copy files between host and box (like `docker cp`)',
  checkpoint: 'List and manage project checkpoints (warm state new boxes start from)',
  'git pull': 'Fetch via the relay then merge in /workspace (or switch branch first)',
  prepare: "Build provider base images / snapshots, or show what's prepared",
  docker: 'Local Docker provider (the default) — sugar for `--provider docker`',
  daytona: 'Daytona cloud provider — credentials + `--provider daytona` sugar',
  hetzner: 'Hetzner Cloud VPS provider — credentials, firewall + provider sugar',
  vercel: 'Vercel Sandbox provider — credentials + `--provider vercel` sugar',
  e2b: 'E2B sandbox provider — credentials + `--provider e2b` sugar',
  digitalocean: 'DigitalOcean Droplet provider — credentials, firewall + provider sugar',
  'remote-docker': 'Docker on a machine you own, over SSH — provider sugar',
  inbound: "Set a VPS box's inbound-access policy (per-box firewall)",
  connect: "Print a VPS box's SSH details to drive it from another device",
  prune: 'Clean up orphan state records (--all: orphan docker resources)',
  doctor: 'Diagnose system compatibility and provider readiness',
  'self-update': 'Update agentbox, host skills, box image, relay/hub, and the tray app',
  install: 'Interactive setup wizard: pick a provider, log in, prepare its image',
  app: 'Control the AgentBox menu-bar app',
  config: 'Read / write layered config (global, project, workspace)',
  hub: 'Run the AgentBox hub — relay + Web UI on http://127.0.0.1:8787',
};

// Left-column overrides for the grouped `agentbox help` list, keyed by the
// HELP_GROUPS entry — for rows that read better as a full invocation than as
// the bare (sub)command name.
const TERM_OVERRIDES: Record<string, string> = {
  'git pr': 'pr create -f',
};

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
  const grouped = new Set(HELP_GROUPS.flatMap((g) => g.commands.map((n) => n.split(' ')[0]!)));
  const orphans = visible.map((c) => c.name()).filter((n) => !grouped.has(n));

  const groups: HelpGroup[] = [...HELP_GROUPS];
  if (orphans.length) groups.push({ title: 'Other', commands: orphans });

  // 'parent sub' entries resolve to the nested Command; depth drives the
  // extra indent that renders them as a tree under their parent row.
  const resolve = (name: string): { cmd: Command; depth: number } | undefined => {
    const parts = name.split(' ');
    let cmd = byName.get(parts[0]!);
    for (const part of parts.slice(1)) {
      cmd = cmd?.commands.find((c) => c.name() === part || c.aliases().includes(part));
    }
    return cmd ? { cmd, depth: parts.length - 1 } : undefined;
  };

  const rowTerm = (name: string, cmd: Command): string => TERM_OVERRIDES[name] ?? term(cmd);

  const termWidths: number[] = [];
  for (const g of groups) {
    for (const name of g.commands) {
      const row = resolve(name);
      if (row) termWidths.push(rowTerm(name, row.cmd).length + row.depth * 2);
    }
  }
  const pad = Math.max(0, ...termWidths) + 2;
  const descBudget = MAX_HELP_LINE - 4 - pad;

  const lines: string[] = ['Commands:'];
  for (const g of groups) {
    const title = g.hint ? `${g.title}  (${g.hint})` : g.title;
    lines.push('', `  ${title}`);
    for (const name of g.commands) {
      const row = resolve(name);
      if (!row) continue;
      const description = SHORT_DESCRIPTIONS[name] ?? row.cmd.description();
      const indent = '    ' + '  '.repeat(row.depth);
      lines.push(
        `${indent}${rowTerm(name, row.cmd).padEnd(pad - row.depth * 2)}${clip(description, descBudget)}`,
      );
    }
  }
  lines.push('', 'Run `agentbox <command> --help` for command-specific options.');
  return lines.join('\n');
}

// Hard ceiling for a rendered help line — one row per command, no wrapping
// even on modest terminals. Descriptions past the budget clip at a word
// boundary; the curated SHORT_DESCRIPTIONS above should make this a no-op.
const MAX_HELP_LINE = 100;

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf(' ', budget - 1);
  return `${text.slice(0, cut > budget / 2 ? cut : budget - 1).trimEnd()}…`;
}

// Compact view rendered by the default `agentbox --help`: only the core
// start → attach → git flow → destroy workflow, with related commands
// aggregated onto one line. Everything else lives in `agentbox help`
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
        description: 'Push box commits to the remote, pull host changes into the box, open PRs',
      },
    ],
  },
];

const COMPACT_EXAMPLE = [
  'Example:',
  '  agentbox claude                  # launch Claude, one box per task/branch',
  '  agentbox hetzner|e2b|… codex     # launch with other agents or providers',
  '  ! agentbox fork hetzner|e2b|…    # teleport the current session from the chat',
  '',
  '  agentbox attach 1                # detach with Ctrl+a d, then re-attach',
  '',
  '  # Then ask your agent to push/pr or do it from your pc:',
  '  agentbox git push 1              # push to remote',
  '  agentbox git push 1 --host-only  # move back the branch to your pc',
  '  agentbox git pr create 1 -f      # create a PR from the box',
  '  agentbox destroy                 # remove the box',
  '',
  '  # Or ask your host agent (via the /agentbox-info skill) to spin up',
  '  # boxes for subtasks and orchestrate them for you',
];

// Rendered as a last pseudo-group inside the Commands block (same indentation
// as the real groups) so the pointer to the full list doesn't get lost in the
// footer text.
const COMPACT_MORE = [
  '  More in `agentbox help`',
  '    dashboard, pause|stop|checkpoint, claude|codex|opencode,',
  '    connect|download|services|inbound, drive|queue, config, …',
];

const COMPACT_FOOTER = ['Run `agentbox <command> --help` for command options.'];

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
  lines.push('', ...COMPACT_MORE, '', ...COMPACT_EXAMPLE, '', ...COMPACT_FOOTER);
  return lines.join('\n');
}
