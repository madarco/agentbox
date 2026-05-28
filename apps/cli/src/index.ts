// Suppress Docker CLI hints (the "What's next?" / promotional lines that
// appear after some docker subcommands). Affects every `docker …` we spawn
// because the var inherits via process.env. We use `??=` so a user who
// explicitly set DOCKER_CLI_HINTS in their shell still wins.
process.env.DOCKER_CLI_HINTS ??= 'false';

// Build-time CLI version stamps. The provider packages (sandbox-docker,
// sandbox-hetzner, sandbox-daytona) read these lazily — at prepare/create/
// checkpoint time, never at import — so the ESM-hoists-imports-first order
// is fine. Set via env so the provider packages don't need a compile-time
// dep on apps/cli's bundled-only version module.
import { AGENTBOX_COMMIT, AGENTBOX_VERSION } from './version.js';
process.env.AGENTBOX_CLI_VERSION = AGENTBOX_VERSION;
process.env.AGENTBOX_CLI_COMMIT = AGENTBOX_COMMIT;

import { Command } from 'commander';
import { applyEngineOverrideAtStartup } from './engine-override.js';
import { buildGroupedHelp } from './help.js';
import { agentCommand } from './commands/agent.js';
import { claudeCommand } from './commands/claude.js';
import { checkpointCommand } from './commands/checkpoint.js';
import { codeCommand } from './commands/code.js';
import { codexCommand } from './commands/codex.js';
import { opencodeCommand } from './commands/opencode.js';
import { configCommand } from './commands/config.js';
import { cpCommand } from './commands/cp.js';
import { createCommand } from './commands/create.js';
import { dashboardCommand } from './commands/dashboard.js';
import { daytonaCommand } from '@agentbox/sandbox-daytona/cli';
import { dockerCommand } from './commands/docker.js';
import { hetznerCommand } from '@agentbox/sandbox-hetzner/cli';
import { destroyCommand } from './commands/destroy.js';
import { downloadCommand } from './commands/download.js';
import { driveCommand } from './commands/drive.js';
import { forkCommand } from './commands/fork.js';
import { installCommand } from './commands/install.js';
import { gitCommand } from './commands/git.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { openCommand } from './commands/open.js';
import { pauseCommand } from './commands/pause.js';
import { prepareCommand } from './commands/prepare.js';
import { pruneCommand } from './commands/prune.js';
import { queueCommand } from './commands/queue.js';
import { relayCommand } from './commands/relay.js';
import { runQueuedJobCommand } from './commands/_run-queued-job.js';
import { screenCommand } from './commands/screen.js';
import { shellCommand } from './commands/shell.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { topCommand } from './commands/top.js';
import { unpauseCommand } from './commands/unpause.js';
import { updateCommand } from './commands/update.js';
import { urlCommand } from './commands/url.js';
import { waitCommand } from './commands/wait.js';
import { rewriteProviderPrefix } from './provider/argv-prefix.js';

const program = new Command();

program
  .name('agentbox')
  .description('Launch coding agents in isolated sandboxes')
  .version(AGENTBOX_VERSION);

// Required so `agentbox download env --dry-run` binds --dry-run to the `env`
// subcommand rather than the parent `download` (both define it). Positional
// options must be enabled on every ancestor in the chain.
program.enablePositionalOptions();

program.addCommand(createCommand);
program.addCommand(claudeCommand);
program.addCommand(forkCommand);
program.addCommand(codexCommand);
program.addCommand(gitCommand);
program.addCommand(opencodeCommand);
program.addCommand(codeCommand);
program.addCommand(shellCommand);
program.addCommand(listCommand);
program.addCommand(openCommand);
program.addCommand(urlCommand);
program.addCommand(screenCommand);
program.addCommand(downloadCommand);
program.addCommand(cpCommand);
program.addCommand(statusCommand);
program.addCommand(topCommand);
program.addCommand(dashboardCommand);
program.addCommand(driveCommand);
program.addCommand(agentCommand);
program.addCommand(waitCommand);
program.addCommand(logsCommand);
program.addCommand(pauseCommand);
program.addCommand(unpauseCommand);
program.addCommand(stopCommand);
program.addCommand(startCommand);
program.addCommand(destroyCommand);
program.addCommand(prepareCommand);
program.addCommand(pruneCommand);
program.addCommand(checkpointCommand);
program.addCommand(configCommand);
program.addCommand(queueCommand);
program.addCommand(relayCommand);
// Internal worker spawned by the relay's queue scheduler. Hidden from
// `--help` (it shows nothing user-facing — see _run-queued-job.ts).
program.addCommand(runQueuedJobCommand, { hidden: true });
program.addCommand(daytonaCommand);
program.addCommand(hetznerCommand);
program.addCommand(dockerCommand);
program.addCommand(updateCommand);
program.addCommand(installCommand);

program.configureHelp({ visibleCommands: () => [] });
program.addHelpText('after', () => '\n' + buildGroupedHelp(program));

await applyEngineOverrideAtStartup();

program.parseAsync(rewriteProviderPrefix(process.argv)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
