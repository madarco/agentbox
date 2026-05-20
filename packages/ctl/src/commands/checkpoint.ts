import { Command } from 'commander';
import { postRpcAndExit } from '../relay-rpc.js';

interface CheckpointParams {
  name?: string;
  merged?: boolean;
  setDefault?: boolean;
  replace?: boolean;
}

export const checkpointCommand = new Command('checkpoint')
  .description('Capture this box as a project checkpoint (host-side, via the agentbox relay)')
  .option('--name <name>', 'checkpoint name (default: <box-name>-<next>)')
  .option('--merged', 'flatten lower+upper into one tree instead of a layered delta')
  .option('--set-default', 'mark this checkpoint as the project default for new boxes')
  .option(
    '--replace',
    "if a checkpoint with the same name exists, rm it first (idempotent recapture; safe to retry when the previous run's stdout was lost)",
  )
  .action(
    async (opts: { name?: string; merged?: boolean; setDefault?: boolean; replace?: boolean }) => {
      const params: CheckpointParams = {};
      if (opts.name) params.name = opts.name;
      if (opts.merged === true) params.merged = true;
      if (opts.setDefault === true) params.setDefault = true;
      if (opts.replace === true) params.replace = true;
      const code = await postRpcAndExit('checkpoint.create', params, {
        errorPrefix: 'agentbox-ctl checkpoint',
      });
      process.exit(code);
    },
  );
