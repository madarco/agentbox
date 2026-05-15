import { Command } from 'commander';
import { browserCommand } from './commands/browser.js';
import { claudeCommand } from './commands/claude.js';
import { codeCommand } from './commands/code.js';
import { createCommand } from './commands/create.js';
import { destroyCommand } from './commands/destroy.js';
import { inspectCommand } from './commands/inspect.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { openCommand } from './commands/open.js';
import { pathCommand } from './commands/path.js';
import { pauseCommand } from './commands/pause.js';
import { pruneCommand } from './commands/prune.js';
import { shellCommand } from './commands/shell.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { unpauseCommand } from './commands/unpause.js';
import { waitCommand } from './commands/wait.js';

const program = new Command();

program.name('agentbox').description('Launch coding agents in isolated sandboxes').version('0.0.0');

program.addCommand(createCommand);
program.addCommand(claudeCommand);
program.addCommand(codeCommand);
program.addCommand(shellCommand);
program.addCommand(listCommand);
program.addCommand(inspectCommand);
program.addCommand(openCommand);
program.addCommand(browserCommand);
program.addCommand(pathCommand);
program.addCommand(statusCommand);
program.addCommand(waitCommand);
program.addCommand(logsCommand);
program.addCommand(pauseCommand);
program.addCommand(unpauseCommand);
program.addCommand(stopCommand);
program.addCommand(startCommand);
program.addCommand(destroyCommand);
program.addCommand(pruneCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
