import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { COMPACT_HELP, HELP_GROUPS, buildCompactHelp, buildGroupedHelp } from '../src/help.js';
import { agentCommand } from '../src/commands/agent.js';
import { appCommand } from '../src/commands/app.js';
import { attachCommand } from '../src/commands/attach.js';
import { checkpointCommand } from '../src/commands/checkpoint.js';
import { claudeCommand } from '../src/commands/claude.js';
import { codeCommand } from '../src/commands/code.js';
import { codexCommand } from '../src/commands/codex.js';
import { opencodeCommand } from '../src/commands/opencode.js';
import { configCommand } from '../src/commands/config.js';
import { cpCommand } from '../src/commands/cp.js';
import { createCommand } from '../src/commands/create.js';
import { dashboardCommand } from '../src/commands/dashboard.js';
import { daytonaCommand } from '@agentbox/sandbox-daytona/cli';
import { dockerCommand } from '../src/commands/docker.js';
import { hetznerCommand } from '@agentbox/sandbox-hetzner/cli';
import { vercelCommand } from '@agentbox/sandbox-vercel/cli';
import { e2bCommand } from '@agentbox/sandbox-e2b/cli';
import { digitaloceanCommand } from '@agentbox/sandbox-digitalocean/cli';
import { connectCommand } from '../src/commands/connect.js';
import { destroyCommand } from '../src/commands/destroy.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { downloadCommand } from '../src/commands/download.js';
import { driveCommand } from '../src/commands/drive.js';
import { forkCommand } from '../src/commands/fork.js';
import { gitCommand } from '../src/commands/git.js';
import { hubCommand } from '../src/commands/hub.js';
import { inboundCommand } from '../src/commands/inbound.js';
import { installCommand } from '../src/commands/install.js';
import { listCommand } from '../src/commands/list.js';
import { logsCommand } from '../src/commands/logs.js';
import { openCommand } from '../src/commands/open.js';
import { urlCommand } from '../src/commands/url.js';
import { screenCommand } from '../src/commands/screen.js';
import { pauseCommand } from '../src/commands/pause.js';
import { pluginCommand } from '../src/commands/plugin.js';
import { prepareCommand } from '../src/commands/prepare.js';
import { pruneCommand } from '../src/commands/prune.js';
import { queueCommand } from '../src/commands/queue.js';
import { recoverCommand } from '../src/commands/recover.js';
import { relayCommand } from '../src/commands/relay.js';
import { runQueuedJobCommand } from '../src/commands/_run-queued-job.js';
import { servicesCommand } from '../src/commands/services.js';
import { shellCommand } from '../src/commands/shell.js';
import { startCommand } from '../src/commands/start.js';
import { statusCommand } from '../src/commands/status.js';
import { stopCommand } from '../src/commands/stop.js';
import { topCommand } from '../src/commands/top.js';
import { unpauseCommand } from '../src/commands/unpause.js';
import { updateCommand } from '../src/commands/update.js';
import { waitCommand } from '../src/commands/wait.js';

// Mirrors the registration order in src/index.ts. If a command is added there
// it must be added here AND to HELP_GROUPS — the "no Other group" assertion
// below is the drift guard.
function buildProgram(): Command {
  const program = new Command();
  for (const cmd of [
    createCommand,
    claudeCommand,
    forkCommand,
    codexCommand,
    opencodeCommand,
    codeCommand,
    shellCommand,
    attachCommand,
    listCommand,
    openCommand,
    urlCommand,
    screenCommand,
    downloadCommand,
    cpCommand,
    statusCommand,
    servicesCommand,
    topCommand,
    dashboardCommand,
    driveCommand,
    agentCommand,
    waitCommand,
    logsCommand,
    pauseCommand,
    unpauseCommand,
    inboundCommand,
    connectCommand,
    stopCommand,
    startCommand,
    recoverCommand,
    destroyCommand,
    prepareCommand,
    pruneCommand,
    checkpointCommand,
    configCommand,
    queueCommand,
    relayCommand,
    hubCommand,
    daytonaCommand,
    hetznerCommand,
    dockerCommand,
    vercelCommand,
    e2bCommand,
    digitaloceanCommand,
    gitCommand,
    doctorCommand,
    updateCommand,
    installCommand,
    appCommand,
    pluginCommand,
  ]) {
    program.addCommand(cmd);
  }
  // The queue worker is hidden — buildGroupedHelp filters it out, so it must
  // NOT appear in HELP_GROUPS either. Register it the same way index.ts does
  // (with `{ hidden: true }`) so the drift assertion mirrors production.
  program.addCommand(runQueuedJobCommand, { hidden: true });
  return program;
}

describe('grouped --help', () => {
  it('every group command name resolves to a registered command', () => {
    const registered = new Set(buildProgram().commands.map((c) => c.name()));
    for (const g of HELP_GROUPS) {
      for (const name of g.commands) {
        expect(registered.has(name), `${name} in group "${g.title}"`).toBe(true);
      }
    }
  });

  it('groups cover every registered command (no Other group / drift)', () => {
    const help = buildGroupedHelp(buildProgram());
    expect(help).not.toContain('Other');
    const grouped = HELP_GROUPS.flatMap((g) => g.commands).sort();
    // Hidden internal commands (e.g. `_run-queued-job`) are intentionally
    // excluded from HELP_GROUPS; mirror that filter when comparing.
    const registered = buildProgram()
      .commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
      .map((c) => c.name())
      .sort();
    expect(grouped).toEqual(registered);
  });

  it('hidden internal commands stay out of the rendered help', () => {
    const help = buildGroupedHelp(buildProgram());
    expect(help).not.toContain('_run-queued-job');
  });

  it('renders each group title and the help footer', () => {
    const help = buildGroupedHelp(buildProgram());
    for (const g of HELP_GROUPS) expect(help).toContain(g.title);
    expect(help).toContain('Advanced');
    expect(help).toContain('Run `agentbox <command> --help`');
    // url/screen are top-level commands listed under Access.
    expect(help).toMatch(/^\s+url\s/m);
    expect(help).toMatch(/^\s+screen\s/m);
    // `path` was folded into `open --path`; not a standalone command.
    expect(help).not.toMatch(/^\s+path\s/m);
  });
});

describe('compact --help (default view)', () => {
  it('every compact row command resolves to a registered command', () => {
    const registered = new Set(buildProgram().commands.map((c) => c.name()));
    for (const g of COMPACT_HELP) {
      for (const row of g.rows) {
        for (const name of row.commands) {
          expect(registered.has(name), `${name} in compact group "${g.title}"`).toBe(true);
        }
      }
    }
  });

  it('aggregated rows carry an explicit description', () => {
    for (const g of COMPACT_HELP) {
      for (const row of g.rows) {
        if (row.commands.length > 1) {
          expect(row.description, `aggregated row ${row.commands.join('|')}`).toBeTruthy();
        }
      }
    }
  });

  it('shows the core workflow, an example, and the help --all recap', () => {
    const help = buildCompactHelp(buildProgram());
    expect(help).toContain('claude|codex|opencode');
    expect(help).toContain('url|screen|open|code');
    expect(help).toContain('git push|pull|pr');
    expect(help).toMatch(/^\s+list\|ls\s/m);
    expect(help).toMatch(/^\s+destroy\|rm\s/m);
    expect(help).toContain('Example:');
    expect(help).toContain('agentbox git push');
    expect(help).toContain('Run `agentbox <command> --help`');
    expect(help).toContain('`agentbox help --all`');
    expect(help).toContain('drive|queue');
    expect(help).toContain('connect|download|services|inbound');
  });

  it('hides advanced commands from the compact view', () => {
    const help = buildCompactHelp(buildProgram());
    for (const name of ['drive', 'queue', 'pause', 'prepare', 'daytona', 'checkpoint']) {
      expect(help, `${name} must not be a compact row`).not.toMatch(
        new RegExp(String.raw`^\s+${name}\s`, 'm'),
      );
    }
  });
});
