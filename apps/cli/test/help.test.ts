import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { HELP_GROUPS, buildGroupedHelp } from '../src/help.js';
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
import { destroyCommand } from '../src/commands/destroy.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { downloadCommand } from '../src/commands/download.js';
import { driveCommand } from '../src/commands/drive.js';
import { forkCommand } from '../src/commands/fork.js';
import { gitCommand } from '../src/commands/git.js';
import { installCommand } from '../src/commands/install.js';
import { listCommand } from '../src/commands/list.js';
import { logsCommand } from '../src/commands/logs.js';
import { openCommand } from '../src/commands/open.js';
import { urlCommand } from '../src/commands/url.js';
import { screenCommand } from '../src/commands/screen.js';
import { pauseCommand } from '../src/commands/pause.js';
import { prepareCommand } from '../src/commands/prepare.js';
import { pruneCommand } from '../src/commands/prune.js';
import { queueCommand } from '../src/commands/queue.js';
import { relayCommand } from '../src/commands/relay.js';
import { runQueuedJobCommand } from '../src/commands/_run-queued-job.js';
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
    topCommand,
    dashboardCommand,
    driveCommand,
    agentCommand,
    waitCommand,
    logsCommand,
    pauseCommand,
    unpauseCommand,
    stopCommand,
    startCommand,
    destroyCommand,
    prepareCommand,
    pruneCommand,
    checkpointCommand,
    configCommand,
    queueCommand,
    relayCommand,
    daytonaCommand,
    hetznerCommand,
    dockerCommand,
    vercelCommand,
    e2bCommand,
    gitCommand,
    doctorCommand,
    updateCommand,
    installCommand,
    appCommand,
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
