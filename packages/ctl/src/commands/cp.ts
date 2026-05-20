import { Command } from 'commander';
import { postRpcAndExit } from '../relay-rpc.js';

interface CpRpcParams {
  boxPath: string;
  hostPath: string;
  recursive?: boolean;
}

/**
 * `agentbox-ctl cp toHost|fromHost <boxPath> <hostPath>` — ask the host
 * (via relay) to copy a file/dir between this box and the host. The user
 * is prompted on the host wrapper to confirm; denials come back as exit 10
 * with `denied by user` on stderr.
 *
 * `<boxPath>` is a path inside this container (no `<name>:` prefix — the
 * relay knows which box we are from the bearer token). `<hostPath>` is an
 * absolute or `~`-anchored path on the host.
 *
 * Direction labels chosen for clarity at the agent's call site:
 *   `toHost`   = box -> host (push out)
 *   `fromHost` = host -> box (pull in)
 */
export const cpCommand = new Command('cp')
  .description('Copy a file/dir between this box and the host (gated by user prompt on the host wrapper)')
  .addCommand(
    new Command('toHost')
      .description('Copy box:<boxPath> -> host:<hostPath>')
      .argument('<boxPath>', 'source path inside the container')
      .argument('<hostPath>', 'destination path on the host')
      .option('--no-recursive', 'reserved; current implementation is always recursive (docker cp -a)')
      .action(async (boxPath: string, hostPath: string, opts: { recursive: boolean }) => {
        const params: CpRpcParams = { boxPath, hostPath };
        if (opts.recursive === false) params.recursive = false;
        const code = await postRpcAndExit('cp.toHost', params, {
          errorPrefix: 'agentbox-ctl cp',
        });
        process.exit(code);
      }),
  )
  .addCommand(
    new Command('fromHost')
      .description('Copy host:<hostPath> -> box:<boxPath>')
      .argument('<hostPath>', 'source path on the host')
      .argument('<boxPath>', 'destination path inside the container')
      .option('--no-recursive', 'reserved; current implementation is always recursive (docker cp -a)')
      .action(async (hostPath: string, boxPath: string, opts: { recursive: boolean }) => {
        const params: CpRpcParams = { boxPath, hostPath };
        if (opts.recursive === false) params.recursive = false;
        const code = await postRpcAndExit('cp.fromHost', params, {
          errorPrefix: 'agentbox-ctl cp',
        });
        process.exit(code);
      }),
  );
