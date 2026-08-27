import { Command } from 'commander';
import { failUnknownSubcommand } from '../lib/unknown-subcommand.js';

// Help-discoverable entry point for the `agentbox docker <subcmd>` sugar.
// The actual rewrite happens before commander parses (see
// provider/argv-prefix.ts), so this command has no action handler — it only
// shows up when the user types `agentbox docker` (or `agentbox docker --help`)
// without one of the sugared subcommands.
export const dockerCommand = new Command('docker')
  .description(
    'Local Docker provider — sugar for `--provider docker` (e.g. `agentbox docker create|claude|codex|opencode`)',
  )
  .action(() => {
    // No subcommands to dispatch to, so the shared preSubcommand guard can't
    // fire here — an unsugared operand would otherwise print help and exit 0.
    const [unknown] = dockerCommand.args;
    if (unknown) failUnknownSubcommand(dockerCommand, unknown);
    dockerCommand.help();
  });
