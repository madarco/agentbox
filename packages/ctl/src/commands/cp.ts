import { Command } from 'commander';
import { postRpcAndExit } from '../relay-rpc.js';

interface CpRpcParams {
  /** Source path(s): box paths for toHost, host paths for fromHost. */
  sources: string[];
  /** Destination path: host path for toHost, box path for fromHost. */
  dest: string;
  recursive?: boolean;
  /** tar glob patterns / bare dir names to exclude from the copy. */
  exclude?: string[];
  /** false to keep the heavy dirs the host CLI drops by default. */
  defaultExcludes?: boolean;
  /** true to copy even when a source is over the host's size limit. */
  yes?: boolean;
}

interface CpCliOptions {
  recursive: boolean;
  exclude: string[];
  defaultExcludes: boolean;
  yes: boolean;
}

function collectExclude(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

/**
 * Split a variadic path list into sources + destination. Commander requires
 * the variadic to be the last argument, so the last path is the destination
 * and the rest are sources — needs at least one source plus the destination.
 */
function buildCpParams(paths: string[], opts: CpCliOptions): CpRpcParams {
  if (paths.length < 2) {
    throw new Error('needs at least one source and a destination, e.g. `cp toHost /workspace/foo ./out/`.');
  }
  const sources = paths.slice(0, -1);
  const dest = paths[paths.length - 1]!;
  const params: CpRpcParams = { sources, dest };
  if (opts.recursive === false) params.recursive = false;
  if (opts.exclude.length > 0) params.exclude = opts.exclude;
  if (opts.defaultExcludes === false) params.defaultExcludes = false;
  if (opts.yes) params.yes = true;
  return params;
}

/**
 * `agentbox-ctl cp toHost|fromHost <paths...>` — ask the host (via relay) to
 * copy file(s)/dir(s) between this box and the host. The user is prompted on
 * the host wrapper to confirm; denials come back as exit 10 with `denied by
 * user` on stderr.
 *
 * The last path is the destination; the rest are sources. With >=2 sources the
 * destination must be a directory. Wildcards are expanded by *this* shell
 * before ctl sees them, so `cp toHost /workspace/dist/*.js ./out/` works (the
 * box shell globs the box paths); a `fromHost` wildcard would (wrongly) glob
 * against the box FS, so list host sources explicitly there.
 *
 * Box paths carry no `<name>:` prefix (the relay knows which box we are from
 * the bearer token). A relative host path resolves against this box's host
 * workspace (the host dir that mirrors `/workspace`), not wherever the host
 * relay happens to be running.
 *
 * Direction labels chosen for clarity at the agent's call site:
 *   `toHost`   = box -> host (push out)
 *   `fromHost` = host -> box (pull in)
 */
export const cpCommand = new Command('cp')
  .description('Copy file(s)/dir(s) between this box and the host (gated by user prompt on the host wrapper)')
  .addCommand(
    new Command('toHost')
      .description('Copy box source(s) -> host destination (last path is the dest)')
      .argument('<paths...>', 'box source path(s) inside the container, then the host destination')
      .option('--no-recursive', 'reserved; current implementation is always recursive (docker cp -a)')
      .option('--exclude <pattern>', 'exclude paths matching <pattern> (repeatable)', collectExclude, [])
      .option('--no-default-excludes', 'keep heavy dirs the host drops by default (.git, node_modules, ...)')
      .option('-y, --yes', 'copy even if a source is over the host size limit')
      .action(async (paths: string[], opts: CpCliOptions) => {
        let params: CpRpcParams;
        try {
          params = buildCpParams(paths, opts);
        } catch (err) {
          process.stderr.write(`agentbox-ctl cp: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(64);
        }
        const code = await postRpcAndExit('cp.toHost', params, { errorPrefix: 'agentbox-ctl cp' });
        process.exit(code);
      }),
  )
  .addCommand(
    new Command('fromHost')
      .description('Copy host source(s) -> box destination (last path is the dest)')
      .argument('<paths...>', 'host source path(s) (relative resolves against the box workspace), then the box destination')
      .option('--no-recursive', 'reserved; current implementation is always recursive (docker cp -a)')
      .option('--exclude <pattern>', 'exclude paths matching <pattern> (repeatable)', collectExclude, [])
      .option('--no-default-excludes', 'keep heavy dirs the host drops by default (.git, node_modules, ...)')
      .option('-y, --yes', 'copy even if a source is over the host size limit')
      .action(async (paths: string[], opts: CpCliOptions) => {
        let params: CpRpcParams;
        try {
          params = buildCpParams(paths, opts);
        } catch (err) {
          process.stderr.write(`agentbox-ctl cp: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(64);
        }
        const code = await postRpcAndExit('cp.fromHost', params, { errorPrefix: 'agentbox-ctl cp' });
        process.exit(code);
      }),
  );
