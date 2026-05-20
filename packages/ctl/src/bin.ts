import { Command } from 'commander';
import { claudeSessionCommand } from './commands/claude-session.js';
import { claudeStateCommand } from './commands/claude-state.js';
import { cpCommand } from './commands/cp.js';
import { daemonCommand } from './commands/daemon.js';
import { downloadCommand } from './commands/download.js';
import { checkpointCommand } from './commands/checkpoint.js';
import { gitCommand } from './commands/git.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { validateCommand } from './commands/validate.js';
import { waitReadyCommand } from './commands/wait-ready.js';
import { runTaskCommand } from './commands/run-task.js';
import {
  reloadCommand,
  restartCommand,
  startServiceCommand,
  stopServiceCommand,
} from './commands/control.js';

const program = new Command();

program
  .name('agentbox-ctl')
  .description('In-container supervisor daemon and client for AgentBox')
  .version('0.0.0');

program.addCommand(daemonCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(validateCommand);
program.addCommand(restartCommand);
program.addCommand(stopServiceCommand);
program.addCommand(startServiceCommand);
program.addCommand(reloadCommand);
program.addCommand(claudeSessionCommand);
program.addCommand(claudeStateCommand);
program.addCommand(waitReadyCommand);
program.addCommand(runTaskCommand);
program.addCommand(gitCommand);
program.addCommand(checkpointCommand);
program.addCommand(cpCommand);
program.addCommand(downloadCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentbox-ctl: ${msg}\n`);
  process.exit(1);
});
