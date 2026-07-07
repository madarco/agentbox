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

// Stamp the staged `runtime/` root so externally-installed provider plugins can
// resolve the shared box-side assets (ctl.cjs + shims) from the RUNNING CLI via
// `@madarco/agentbox-provider-sdk`'s `resolveSharedRuntimeAsset`. Probe both bundle
// layouts (dist/index.js and dist/<chunk>.js) for the `_shared` marker.
import { existsSync as _existsSync } from 'node:fs';
import { dirname as _dirname, resolve as _resolve } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
{
  const selfDir = _dirname(_fileURLToPath(import.meta.url));
  for (const cand of [
    _resolve(selfDir, '..', 'runtime'),
    _resolve(selfDir, '..', '..', 'runtime'),
  ]) {
    if (_existsSync(_resolve(cand, '_shared'))) {
      process.env.AGENTBOX_CLI_RUNTIME_DIR = cand;
      break;
    }
  }
}

import { Command } from 'commander';
import { applyEngineOverrideAtStartup } from './engine-override.js';
import { buildGroupedHelp } from './help.js';
import { agentCommand } from './commands/agent.js';
import { appCommand } from './commands/app.js';
import { attachCommand } from './commands/attach.js';
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
import { vercelCommand } from '@agentbox/sandbox-vercel/cli';
import { e2bCommand } from '@agentbox/sandbox-e2b/cli';
import { destroyCommand } from './commands/destroy.js';
import { downloadCommand } from './commands/download.js';
import { driveCommand } from './commands/drive.js';
import { forkCommand } from './commands/fork.js';
import { installCommand, runInstallWizard } from './commands/install.js';
import { pluginCommand } from './commands/plugin.js';
import { doctorCommand } from './commands/doctor.js';
import { isFirstRun } from './lib/first-run.js';
import { printCliError } from './lib/print-cli-error.js';
import { gitCommand } from './commands/git.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { openCommand } from './commands/open.js';
import { pauseCommand } from './commands/pause.js';
import { prepareCommand } from './commands/prepare.js';
import { pruneCommand } from './commands/prune.js';
import { queueCommand } from './commands/queue.js';
import { relayCommand } from './commands/relay.js';
import { hubCommand } from './commands/hub.js';
import { controlPlaneCommand } from './commands/control-plane.js';
import { runQueuedJobCommand } from './commands/_run-queued-job.js';
import { runQueuedPrepareCommand } from './commands/_run-queued-prepare.js';
import { claudeLoginWorkerCommand } from './commands/_claude-login-worker.js';
import { herdrCommand } from './commands/herdr.js';
import { recoverCommand } from './commands/recover.js';
import { screenCommand } from './commands/screen.js';
import { servicesCommand } from './commands/services.js';
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
program.addCommand(attachCommand);
program.addCommand(listCommand);
program.addCommand(openCommand);
program.addCommand(urlCommand);
program.addCommand(screenCommand);
program.addCommand(downloadCommand);
program.addCommand(cpCommand);
program.addCommand(statusCommand);
program.addCommand(servicesCommand);
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
program.addCommand(recoverCommand);
program.addCommand(destroyCommand);
program.addCommand(prepareCommand);
program.addCommand(pruneCommand);
program.addCommand(checkpointCommand);
program.addCommand(configCommand);
program.addCommand(queueCommand);
program.addCommand(relayCommand);
program.addCommand(hubCommand);
// Experimental + WIP (hosted control plane / deployed hub). Hidden from the main
// `agentbox --help` list; still runnable and self-documented via `control-plane --help`.
program.addCommand(controlPlaneCommand, { hidden: true });
// Internal worker spawned by the relay's queue scheduler. Hidden from
// `--help` (it shows nothing user-facing — see _run-queued-job.ts).
program.addCommand(runQueuedJobCommand, { hidden: true });
// Internal worker that bakes a provider base image for a `kind: 'prepare'` queue
// job (hub-driven), streaming progress to the job log. Hidden.
program.addCommand(runQueuedPrepareCommand, { hidden: true });
// Internal worker that drives `claude auth login` under a pty for the headless
// (non-TTY / --headless) login flow. Hidden — see _claude-login-worker.ts.
program.addCommand(claudeLoginWorkerCommand, { hidden: true });
// Internal entry points invoked by the Herdr plugin (`agentbox install herdr`).
program.addCommand(herdrCommand, { hidden: true });
program.addCommand(daytonaCommand);
program.addCommand(hetznerCommand);
program.addCommand(vercelCommand);
program.addCommand(e2bCommand);
program.addCommand(dockerCommand);
program.addCommand(updateCommand);
program.addCommand(installCommand);
program.addCommand(appCommand);
program.addCommand(pluginCommand);
program.addCommand(doctorCommand);

program.configureHelp({ visibleCommands: () => [] });
program.addHelpText('after', () => '\n' + buildGroupedHelp(program));

await applyEngineOverrideAtStartup();

const argv = rewriteProviderPrefix(process.argv);

// First-run auto-trigger: if the user has never completed `agentbox install`,
// drop them through the wizard before running their actual command, then
// fall through. Skipped for the wizard / doctor themselves, for help/version,
// for internal/background workers, and any non-TTY invocation (CI must not
// hang on a prompt — they get the existing per-provider credential errors).
const FIRST_RUN_EXEMPT = new Set([
  'install',
  'doctor',
  'help',
  'relay',
  'hub',
  'app',
  '_run-queued-job',
  '_run-queued-prepare',
  '_claude-login-worker',
  'drive',
  'screen',
]);

function isFirstRunHookEligible(args: readonly string[]): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rest = args.slice(2);
  if (rest.length === 0) return false;
  for (const a of rest) {
    if (a === '--help' || a === '-h' || a === '--version' || a === '-V') return false;
  }
  const first = rest[0];
  if (typeof first !== 'string' || first.startsWith('-')) return false;
  if (FIRST_RUN_EXEMPT.has(first)) return false;
  return true;
}

if (isFirstRun() && isFirstRunHookEligible(argv)) {
  try {
    await runInstallWizard({ fromAutoTrigger: true });
  } catch (err) {
    process.stderr.write(
      `install wizard failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

program.parseAsync(argv).catch((err: unknown) => {
  printCliError(err, process.stderr);
  process.exit(1);
});
