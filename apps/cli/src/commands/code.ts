import { spawn } from 'node:child_process';
import { log } from '@clack/prompts';
import { Command, InvalidArgumentError } from 'commander';
import type { BoxRecord } from '@agentbox/core';
import type { StatusReply, WaitReadyReply } from '@agentbox/ctl';
import { loadEffectiveConfig, type IdeFlavor as ConfigIdeFlavor, type UserConfig } from '@agentbox/config';
import {
  attachedContainerUri,
  ensureAgentboxTasksFile,
  execInBox,
  getDockerContext,
  ideProfile,
  inspectBox,
  startBox,
  unpauseBox,
  type IdeFlavor,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { agentboxAliasFor, writeAgentboxSshAlias } from '../ssh-config.js';
import { handleLifecycleError } from './_errors.js';

interface CodeOptions {
  // commander stores `--no-wait` / `--no-auto-terminals` under the positive
  // key (`wait` / `autoTerminals`), defaulting to true and flipping to false.
  wait?: boolean;
  timeout?: string;
  autoTerminals?: boolean;
  regenTasks?: boolean;
  print?: boolean;
  ide?: IdeFlavor;
}

function buildCodeCliOverrides(opts: CodeOptions): Partial<UserConfig> {
  const code: NonNullable<UserConfig['code']> = {};
  if (opts.ide !== undefined) code.ide = opts.ide as ConfigIdeFlavor;
  if (opts.wait === false) code.wait = false;
  if (opts.autoTerminals === false) code.autoTerminals = false;
  if (opts.timeout !== undefined) {
    const n = Number(opts.timeout);
    if (Number.isFinite(n) && Number.isInteger(n)) code.timeoutMs = n;
  }
  return Object.keys(code).length > 0 ? { code } : {};
}

function parseIdeFlavor(value: string): IdeFlavor {
  if (value === 'vscode' || value === 'cursor') return value;
  throw new InvalidArgumentError(`expected one of: vscode, cursor (got "${value}")`);
}

export const codeCommand = new Command('code')
  .description('Open a box in VS Code or Cursor via the Dev Containers extension')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--no-wait', "don't block on agentbox-ctl wait-ready before opening")
  .option('--timeout <ms>', 'wait-ready timeout in milliseconds (default from config; built-in: 120000)')
  .option('--no-auto-terminals', "don't generate /workspace/.vscode/tasks.json")
  .option('--regen-tasks', 'overwrite a user-owned tasks.json (skips sentinel check)', false)
  .option(
    '--ide <flavor>',
    'force a specific IDE: vscode | cursor (default from config; built-in: auto)',
    parseIdeFlavor,
  )
  .option(
    '--print',
    'print the folder URI instead of launching the IDE (still refreshes/waits)',
  )
  .action(async (idOrName: string | undefined, opts: CodeOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      // Layered config: workspace = the box's host workspace, not cwd, so
      // per-project defaults follow the box even if you run `agentbox code`
      // from elsewhere.
      const cfg = await loadEffectiveConfig(box.workspacePath, {
        cliOverrides: buildCodeCliOverrides(opts),
      });
      const wait = cfg.effective.code.wait;
      const autoTerminals = cfg.effective.code.autoTerminals;
      const timeoutMs = String(cfg.effective.code.timeoutMs);
      const ide = cfg.effective.code.ide;
      const forcedIde: IdeFlavor | undefined = ide === 'auto' ? undefined : (ide as IdeFlavor);

      const provider = box.provider ?? 'docker';
      const folderUri =
        provider === 'docker'
          ? await prepareDockerAttach(box, { wait, autoTerminals, timeoutMs, regenTasks: opts.regenTasks })
          : await prepareCloudAttach(box, { wait, timeoutMs });

      if (opts.print) {
        process.stdout.write(folderUri + '\n');
        return;
      }
      const exit = await launchIde(folderUri, forcedIde);
      if (exit.code !== 0) {
        log.error(`failed to launch ${exit.flavor ? ideProfile(exit.flavor).displayName : 'IDE'} via ${exit.via} (exit ${String(exit.code)})`);
        process.stdout.write(folderUri + '\n');
        process.exit(1);
      }
      log.success(
        `opening ${box.name} in ${ideProfile(exit.flavor).displayName} (${exit.via})`,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface PrepareDockerOptions {
  wait: boolean;
  autoTerminals: boolean;
  timeoutMs: string;
  regenTasks?: boolean;
}

async function prepareDockerAttach(box: BoxRecord, opts: PrepareDockerOptions): Promise<string> {
  // Bring the box online if it isn't already.
  const insp = await inspectBox(box.id);
  if (insp.state === 'paused') {
    log.info(`box is paused; unpausing`);
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    log.info(`box is stopped; starting`);
    await startBox(box.id);
  } else if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }

  // Wait for tasks + autostart services to be ready.
  if (opts.wait) {
    const reply = await runWaitReadyDocker(box.container, opts.timeoutMs);
    if (!reply.ready) {
      const lines: string[] = [];
      if (reply.timedOut.length > 0) lines.push(`timed out: ${reply.timedOut.join(', ')}`);
      if (reply.failed.length > 0) lines.push(`failed: ${reply.failed.join(', ')}`);
      log.warn(`box not fully ready (${lines.join('; ')}). Opening anyway.`);
    } else {
      log.success('all units ready');
    }
  }

  // Inject .vscode/tasks.json so the IDE auto-opens terminal panels.
  // (Cursor reads the same .vscode/ path; it's a VS Code fork.)
  if (opts.autoTerminals) {
    try {
      const services = await fetchServiceNamesDocker(box.container);
      const r = await ensureAgentboxTasksFile(box.container, services, {
        regen: opts.regenTasks,
      });
      if (r.status === 'wrote') {
        log.info(`wrote /workspace/.vscode/tasks.json (${String(services.length)} service(s))`);
      } else if (r.status === 'skipped-user-owned') {
        log.warn(
          'user-owned .vscode/tasks.json detected; skipping auto-terminals (pass --regen-tasks to overwrite)',
        );
      }
    } catch (err) {
      log.warn(
        `auto-terminals failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Embed the active Docker context so the Dev Containers extension
  // attaches via the same daemon agentbox used — without it, switching
  // engines (OrbStack ⇄ Docker Desktop) makes it probe the wrong daemon
  // and report the container as non-existent.
  const dockerContext = await getDockerContext();
  return attachedContainerUri(box.container, { dockerContext });
}

interface PrepareCloudOptions {
  wait: boolean;
  timeoutMs: string;
}

async function prepareCloudAttach(box: BoxRecord, opts: PrepareCloudOptions): Promise<string> {
  const p = await providerForBox(box);
  const state = await p.probeState(box);
  if (state === 'paused') {
    log.info('box is paused; resuming');
    await p.resume(box);
  } else if (state === 'stopped') {
    log.info('box is stopped; starting');
    await p.start(box);
  } else if (state === 'missing') {
    throw new Error(`cloud sandbox for ${box.name} is missing; was it deleted?`);
  }

  if (opts.wait) {
    try {
      const r = await p.exec(box, ['agentbox-ctl', 'wait-ready', '--json', '--timeout', opts.timeoutMs]);
      const reply = JSON.parse(r.stdout) as WaitReadyReply;
      if (!reply.ready) {
        const lines: string[] = [];
        if (reply.timedOut.length > 0) lines.push(`timed out: ${reply.timedOut.join(', ')}`);
        if (reply.failed.length > 0) lines.push(`failed: ${reply.failed.join(', ')}`);
        log.warn(`box not fully ready (${lines.join('; ')}). Opening anyway.`);
      } else {
        log.success('all units ready');
      }
    } catch (err) {
      log.warn(`wait-ready failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Auto-terminals is docker-only for v1 — writing tasks.json requires a
  // `writeFileInBox` over `backend.exec`. Not load-bearing for the editor
  // attach itself; user can author `.vscode/tasks.json` manually.

  if (!p.buildAttach) {
    throw new Error(
      `cloud provider '${p.name}' does not support SSH attach — \`agentbox code\` requires it`,
    );
  }
  // buildAttach mints a fresh 60-min SSH token via the backend's `attachArgv`.
  // We only want the connect argv here; the inner tmux command is irrelevant
  // (Remote-SSH starts its own session). `noTmux` skips the tmux wrap so
  // argv is the plain `ssh ... <user>@<host>` form.
  const spec = await p.buildAttach(box, 'shell', { noTmux: true });
  const userHost = parseUserHost(spec.argv);
  if (!userHost) {
    throw new Error(
      `could not parse <user>@<host> from cloud SSH argv: ${spec.argv.join(' ')}`,
    );
  }

  const alias = agentboxAliasFor(box.name);
  await writeAgentboxSshAlias({
    alias,
    hostname: userHost.host,
    user: userHost.user,
  });
  log.info(`updated ~/.ssh/config alias ${alias}`);

  return `vscode-remote://ssh-remote+${alias}/workspace`;
}

function parseUserHost(argv: readonly string[]): { user: string; host: string } | undefined {
  // `attachArgv` returns argv where the last element is `<token>@<host>` (the
  // SSH connect target). Walk from the end so options at the front don't get
  // mistaken for the target.
  for (let i = argv.length - 1; i >= 0; i--) {
    const v = argv[i];
    if (!v || v.startsWith('-')) continue;
    const at = v.indexOf('@');
    if (at <= 0) continue;
    return { user: v.slice(0, at), host: v.slice(at + 1) };
  }
  return undefined;
}

async function runWaitReadyDocker(container: string, timeoutMs: string): Promise<WaitReadyReply> {
  const proc = await execInBox(
    container,
    ['agentbox-ctl', 'wait-ready', '--json', '--timeout', timeoutMs],
    { user: 'vscode' },
  );
  try {
    return JSON.parse(proc.stdout) as WaitReadyReply;
  } catch {
    throw new Error(
      `agentbox-ctl wait-ready returned unparseable output: ${proc.stderr || proc.stdout}`,
    );
  }
}

interface LaunchResult {
  code: number;
  flavor: IdeFlavor;
  via: 'cli' | 'open';
}

/**
 * Pick an IDE and launch it.
 *
 *   - With `--ide <flavor>`: require that flavor's CLI; if it's missing,
 *     fall back to its own protocol-handler `open` URL (the %2B bug may
 *     surface) and warn.
 *   - Without `--ide`: try `code` first, then `cursor`. Whichever is found
 *     first wins. If neither, fall back to `open vscode://...` last.
 *
 * The folder URI passed in is the canonical `vscode-remote://` form; Cursor
 * accepts it verbatim because it inherits VS Code's URI handling.
 */
async function launchIde(folderUri: string, forced?: IdeFlavor): Promise<LaunchResult> {
  if (forced) {
    return launchOne(forced, folderUri);
  }
  const code = await tryCli('vscode', folderUri);
  if (code !== null) return code;
  const cursor = await tryCli('cursor', folderUri);
  if (cursor !== null) return cursor;
  // Neither CLI present. Last resort: protocol handler via `open`. We pick
  // vscode:// since that's the documented historical fallback.
  log.warn('neither `code` nor `cursor` found in PATH; falling back to `open vscode://...`');
  return launchOne('vscode', folderUri);
}

/**
 * Try the IDE's CLI. Returns null if the binary isn't in PATH so the caller
 * can try the next flavor; otherwise returns the launch result (success or
 * non-127 failure both count as "we ran this one").
 */
async function tryCli(flavor: IdeFlavor, folderUri: string): Promise<LaunchResult | null> {
  const profile = ideProfile(flavor);
  const code = await spawnCommand(profile.cli, ['--folder-uri', folderUri]);
  if (code === 127) return null;
  return { code, flavor, via: 'cli' };
}

/**
 * Run a specific flavor: CLI first; if missing (127), fall back to the
 * flavor-specific protocol handler. Surfaces the %2B-bug warning so the user
 * knows why attach may fail if it does.
 */
async function launchOne(flavor: IdeFlavor, folderUri: string): Promise<LaunchResult> {
  const profile = ideProfile(flavor);
  const cliCode = await spawnCommand(profile.cli, ['--folder-uri', folderUri]);
  if (cliCode !== 127) return { code: cliCode, flavor, via: 'cli' };
  log.warn(
    `\`${profile.cli}\` not found in PATH; falling back to \`open ${profile.protocolScheme}://...\` (the %2B URL-encoding bug may break attach)`,
  );
  const url = `${profile.protocolScheme}://${folderUri.replace(/^vscode-remote:\/\//, 'vscode-remote/')}`;
  const fallback = await spawnCommand('open', [url]);
  return { code: fallback, flavor, via: 'open' };
}

function spawnCommand(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('error', () => resolve(127));
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

async function fetchServiceNamesDocker(container: string): Promise<{ name: string }[]> {
  const proc = await execInBox(container, ['agentbox-ctl', 'status', '--json'], {
    user: 'vscode',
  });
  if (proc.exitCode !== 0) return [];
  try {
    const reply = JSON.parse(proc.stdout) as StatusReply;
    return reply.services.map((s) => ({ name: s.name }));
  } catch {
    return [];
  }
}
