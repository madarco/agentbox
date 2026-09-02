import { Command } from 'commander';
import { bootstrapCommand } from './commands/bootstrap.js';
import { agentCommand } from './commands/agent-render.js';
import { agentSessionCommand } from './commands/agent-session.js';
import { buildAgentStateCommand, LEGACY_AGENT_STATE_COMMANDS } from './commands/agent-state.js';
import { cpCommand } from './commands/cp.js';
import { daemonCommand } from './commands/daemon.js';
import { downloadCommand } from './commands/download.js';
import { checkpointCommand } from './commands/checkpoint.js';
import { ghCommand } from './commands/gh.js';
import { toolCommand } from './commands/tool.js';
import { gitCommand } from './commands/git.js';
import { notifyCommand } from './commands/notify.js';
import { openCommand } from './commands/open.js';
import { renderCommand } from './commands/render.js';
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
program.addCommand(bootstrapCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(validateCommand);
program.addCommand(restartCommand);
program.addCommand(stopServiceCommand);
program.addCommand(startServiceCommand);
program.addCommand(reloadCommand);
program.addCommand(agentCommand);
program.addCommand(agentSessionCommand);
program.addCommand(buildAgentStateCommand({ kind: 'generic' }));
// The frozen per-agent command names. Generated, not hand-written — and kept
// rather than folded into `agent-state` because the seeded hook/plugin files
// that invoke them live in agent config volumes SHARED BETWEEN BOXES: a
// `hooks.json` written by a newer image can be read by a box running an older
// baked ctl, so the spelling those files use must not move. A new agent needs
// no entry here; it uses `agent-state <id>`.
for (const legacy of LEGACY_AGENT_STATE_COMMANDS) {
  program.addCommand(buildAgentStateCommand({ kind: 'agent', ...legacy }));
}
program.addCommand(waitReadyCommand);
program.addCommand(runTaskCommand);
program.addCommand(gitCommand);
program.addCommand(ghCommand);
program.addCommand(checkpointCommand);
program.addCommand(cpCommand);
program.addCommand(renderCommand);
program.addCommand(downloadCommand);
program.addCommand(notifyCommand);
program.addCommand(openCommand);
program.addCommand(toolCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentbox-ctl: ${msg}\n`);
  process.exit(1);
});
