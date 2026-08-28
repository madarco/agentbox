import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  findProjectRoot,
  GLOBAL_TOOLS_FILE,
  isValidToolName,
  loadGrantedTools,
  removeToolGrant,
  resolveProjectToolsFile,
  writeToolGrant,
  type ToolGrant,
} from '@agentbox/config';

/**
 * `agentbox tools` — the host side of the host-tool proxy.
 *
 * A grant here is the human decision that a box may drive one of the host's
 * CLIs with the host's own credentials. The box never receives the tool's
 * token: the relay runs the binary and only the result crosses back. See
 * docs/host-tools.md.
 *
 * `gh` is granted built-in (Claude Code's PR badge depends on it) and keeps
 * its own relay handler; revoke it with
 * `agentbox config set tools.gh.enabled false`.
 */
export const toolsCommand = new Command('tools').description(
  'Grant host CLIs to boxes (the host runs the real binary with host credentials; the box never sees a token)',
);

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

async function scopeFile(global: boolean): Promise<string> {
  if (global) return GLOBAL_TOOLS_FILE;
  return resolveProjectToolsFile(process.cwd());
}

/**
 * Tell running boxes the grant list changed, and say what happened.
 *
 * Boxes no longer poll for this, so the push IS the delivery mechanism — which
 * is also why its failures are reported by name rather than swallowed: an
 * unreachable box is precisely the one where the tool will be missing.
 */
async function announceGrantChange(global: boolean): Promise<void> {
  const { root } = await findProjectRoot(process.cwd());
  const { pushToolGrantChange, describeToolGrantPush } = await import('../lib/tool-grant-push.js');
  const summary = describeToolGrantPush(await pushToolGrantChange({ global, projectRoot: root }));
  if (summary) log.info(summary);
}

toolsCommand
  .command('list')
  .description('Show the host tools granted to this project (global grants included).')
  .action(async () => {
    const { root } = await findProjectRoot(process.cwd());
    const grants = await loadGrantedTools(root);
    const rows = [...grants.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (rows.length === 0) {
      log.info('no host tools granted. Add one with `agentbox tools add <bin>`.');
      return;
    }
    const width = Math.max(...rows.map((g) => g.name.length));
    for (const g of rows) {
      process.stdout.write(`${g.name.padEnd(width)}  ${describeGrant(g)}\n`);
    }
  });

toolsCommand
  .command('add')
  .description(
    'Grant a host CLI. The binary must exist on the host; the box gets a shim that forwards to it.',
  )
  .argument('<name>', 'command name as the box will type it (e.g. terraform)')
  .option('--bin <path>', 'host binary to run, when it differs from the tool name')
  .option(
    '--allow <regex>',
    'argv pattern that runs with no approval prompt (repeatable)',
    collect,
    [],
  )
  .option('--deny <regex>', 'argv pattern refused outright (repeatable)', collect, [])
  .option('--timeout <ms>', 'per-call wall-clock budget in milliseconds')
  .option('--global', 'grant for every project instead of just this one', false)
  .action(
    async (
      name: string,
      opts: {
        bin?: string;
        allow: string[];
        deny: string[];
        timeout?: string;
        global: boolean;
      },
    ) => {
      if (!isValidToolName(name)) {
        log.error(`"${name}" is not a valid tool name (plain command name, no path separators)`);
        process.exitCode = 1;
        return;
      }
      if (name === 'gh') {
        log.error(
          '`gh` is granted built-in and uses its own relay path. Toggle it with `agentbox config set tools.gh.enabled <bool>`.',
        );
        process.exitCode = 1;
        return;
      }
      for (const pattern of [...opts.allow, ...opts.deny]) {
        try {
          new RegExp(pattern);
        } catch (err) {
          log.error(
            `"${pattern}" is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
          return;
        }
      }
      let timeoutMs: number | undefined;
      if (opts.timeout !== undefined) {
        timeoutMs = Number(opts.timeout);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          log.error('--timeout must be a positive integer (milliseconds)');
          process.exitCode = 1;
          return;
        }
      }
      const grant: ToolGrant = {
        name,
        bin: opts.bin ?? name,
        source: 'cli',
        approvedAt: new Date().toISOString(),
        ...(opts.allow.length > 0 ? { allow: opts.allow } : {}),
        ...(opts.deny.length > 0 ? { deny: opts.deny } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const file = await scopeFile(opts.global);
      await writeToolGrant(file, grant);
      log.success(
        `granted ${name} (${opts.global ? 'all projects' : 'this project'}) -> host \`${grant.bin}\``,
      );
      await announceGrantChange(opts.global);
      log.info('`agentbox doctor` shows whether the host binary resolves.');
    },
  );

toolsCommand
  .command('rm')
  .description('Revoke a grant. Running boxes drop the command immediately.')
  .argument('<name>', 'granted tool name')
  .option('--global', 'remove the global grant instead of this project’s', false)
  .action(async (name: string, opts: { global: boolean }) => {
    const file = await scopeFile(opts.global);
    const removed = await removeToolGrant(file, name);
    if (!removed) {
      log.warn(`${name} was not granted ${opts.global ? 'globally' : 'in this project'}`);
      process.exitCode = 1;
      return;
    }
    log.success(`revoked ${name}`);
    await announceGrantChange(opts.global);
  });

function describeGrant(g: ToolGrant): string {
  const parts = [`host: ${g.bin}`, g.source];
  if (g.allow) parts.push(`${String(g.allow.length)} allow`);
  if (g.deny) parts.push(`${String(g.deny.length)} deny`);
  if (g.timeoutMs) parts.push(`${String(g.timeoutMs)}ms`);
  return parts.join('  ');
}
