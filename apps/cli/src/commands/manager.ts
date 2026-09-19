/**
 * `agentbox manager` — the host agent sessions that create and watch boxes.
 *
 * A manager is usually not started here at all: it is the claude or codex
 * session in your terminal, registered the first time it runs `agentbox`
 * (`external`). The hub can also run one (`hub`) in a detached tmux session on
 * its own machine, which the CLI, the tray and a plain terminal all attach to —
 * and it can resume an external session that has ended, which is how "the
 * session that made these boxes" becomes a manager any client can reopen.
 * That is why `start`/`resume`/`stop` go through the API while `attach` is a
 * local `tmux attach`.
 *
 * A manager RUNS on one machine and its RECORD lives on the hub that owns the
 * boxes, which with a control box configured is a different one. So the two
 * halves of this command go to different hubs: the process ops (start, resume,
 * stop, attach, sessions) to the hub on THIS machine, and the record ops (list,
 * status, note, forget) to the configured one. `manager.host` says which machine
 * a given manager is on, and `hostIsHub` whether the hub that answered is it.
 */
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { confirm, isCancel, log, select } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { withHubClient } from '../control-plane/with-hub.js';
import { HubApiError } from '../control-plane/hub-api-client.js';
import { resolveWorkspace, workspaceHub, WorkspaceRefError } from '../lib/workspace-ref.js';
import { detectHostSession, registerHostManager } from '../lib/host-session.js';
import { renderTable } from '../lib/text-table.js';
import { detectHostTerminal, spawnInNewTerminal } from '../terminal/host.js';
import type {
  HubApiClient,
  HubApiManager,
  HubApiWorkspace,
} from '../control-plane/hub-api-client.js';
import type { AttachOpenIn } from '@agentbox/config';
import { visibleAgentSpecs } from '@agentbox/agent-registry';
import { RESUMABLE_MANAGER_AGENTS } from '@agentbox/relay';

/**
 * Agents a manager can be. Registry-driven, so an agent added with
 * `agentbox agent add` is offered too; a SERVICE agent is excluded because a
 * manager is a session you attach to, not a daemon.
 */
function managerAgents(): string[] {
  return visibleAgentSpecs()
    .filter((spec) => spec.caps?.surface !== 'service')
    .map((spec) => spec.id);
}

interface WorkspaceOpt {
  workspace?: string;
}

class ManagerRefError extends Error {}

async function mustResolve(client: HubApiClient, ref?: string): Promise<HubApiWorkspace> {
  try {
    return await resolveWorkspace(client, ref);
  } catch (err) {
    if (err instanceof WorkspaceRefError) {
      log.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

/** Pure: a manager by exact id, or by an unambiguous id prefix of at least 4 chars. */
export function pickManager(managers: HubApiManager[], ref: string): HubApiManager {
  const exact = managers.find((m) => m.id === ref);
  if (exact) return exact;
  const byPrefix = ref.length >= 4 ? managers.filter((m) => m.id.startsWith(ref)) : [];
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) {
    throw new ManagerRefError(
      `"${ref}" matches ${String(byPrefix.length)} managers; use more of the id`,
    );
  }
  throw new ManagerRefError(
    `no manager matches "${ref}". List them with \`agentbox manager list\`.`,
  );
}

/**
 * The workspace a process op is about, resolved on the hub that HOLDS the
 * record. The op itself then goes to the hub on this machine — where the folder,
 * the tmux server and the transcripts are — which reads the same workspace back
 * through its own store.
 */
async function resolveOn(ref?: string): Promise<HubApiWorkspace> {
  const ws = await withHubClient(workspaceHub(), (client) => mustResolve(client, ref));
  if (!ws) process.exit(1);
  return ws;
}

async function mustManager(client: HubApiClient, ref: string): Promise<HubApiManager> {
  try {
    return pickManager(await client.listManagers(), ref);
  } catch (err) {
    if (err instanceof ManagerRefError) {
      log.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

/** The manager this command is running inside, if it is registered. */
async function currentManager(client: HubApiClient): Promise<HubApiManager | undefined> {
  const hint = detectHostSession();
  if (!hint) return undefined;
  return (await client.listManagers()).find(
    (m) => m.agent === hint.agent && m.sessionId === hint.sessionId,
  );
}

function label(m: HubApiManager): string {
  return m.title ?? (m.sessionId ? m.sessionId.slice(0, 8) : '(new session)');
}

function printManager(m: HubApiManager): void {
  log.info(
    `manager ${m.id}: ${m.status} (${m.agent}, ${m.kind === 'tmux' ? 'tmux-run' : 'external'})`,
  );
  process.stdout.write(`  workspace ${m.workspaceName}\n`);
  process.stdout.write(`  folder    ${m.cwd}\n`);
  process.stdout.write(`  host      ${m.host}${runsHere(m) ? ' (this machine)' : ''}\n`);
  if (m.title) process.stdout.write(`  title     ${m.title}\n`);
  if (m.sessionId) process.stdout.write(`  session   ${m.sessionId}\n`);
  if (m.pid !== undefined) process.stdout.write(`  pid       ${String(m.pid)}\n`);
  process.stdout.write(`  boxes     ${String(m.boxIds.length + m.boxJobIds.length)}\n`);
  process.stdout.write(
    `  tasks     ${String(m.taskCounts.open)} open, ${String(m.taskCounts.done)} done\n`,
  );
  process.stdout.write(`  seen      ${ago(m.lastSeenAt)}\n`);
  if (m.status === 'stopped' && m.lastExit !== undefined) {
    process.stdout.write(`  exited    ${String(m.lastExit)}\n`);
  }
  if (m.attachCommand) process.stdout.write(`  attach    ${m.attachCommand}\n`);
}

function renderManagers(managers: HubApiManager[]): void {
  renderTable(
    ['id', 'status', 'kind', 'agent', 'workspace', 'boxes', 'tasks', 'session'],
    managers.map((m) => [
      m.id,
      m.status,
      m.kind,
      m.agent,
      m.workspaceName,
      String(m.boxIds.length + m.boxJobIds.length),
      `${String(m.taskCounts.open)}/${String(m.taskCounts.open + m.taskCounts.done)}`,
      label(m),
    ]),
  );
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${String(hours)}h ago` : `${String(Math.round(hours / 24))}d ago`;
}

/**
 * True when the manager's tmux session is on THIS machine.
 *
 * The record can be served by any hub, so `attachCommand` alone says nothing
 * about where to run it: `host` does. Running tmux against a session on another
 * machine fails with a bare non-zero exit that reads as a broken manager.
 */
export function runsHere(m: Pick<HubApiManager, 'host'>, host: string = hostname()): boolean {
  return m.host === host;
}

/**
 * Whether a refusal from one hub should be retried against this machine's own.
 *
 * `wrong_host` and `manager_unreachable` both carry the machine the manager runs
 * on; when that is this one, the local hub CAN do it — the record simply lives
 * somewhere else.
 */
export function retryOnLocalHub(err: unknown, host: string = hostname()): boolean {
  if (!(err instanceof HubApiError)) return false;
  if (err.code !== 'wrong_host' && err.code !== 'manager_unreachable') return false;
  const details = err.details as { host?: unknown; hosts?: unknown } | undefined;
  // A refusal about a WORKSPACE names every machine that has a checkout of it:
  // `host` is only the first of them, so a two-PC workspace would otherwise
  // refuse the retry on whichever PC lost the coin toss.
  if (Array.isArray(details?.hosts)) return details.hosts.includes(host);
  return typeof details?.host === 'string' && details.host === host;
}

/**
 * Run a `manager message` attempt against the hub that HOLDS the record, and
 * retry against the hub on this machine when it refuses because the session
 * runs here.
 *
 * The retry has to be decided INSIDE the callback: `withHubClient` never
 * rethrows — it reports the {@link HubApiError} and sets `process.exitCode` —
 * so a `catch` around it would never see the refusal, and the user would get
 * the control box's "runs on <host>" instead of the message being typed. A
 * refusal this machine can serve is therefore swallowed here and handed back as
 * a value; anything else is rethrown so the mapper still prints it.
 */
export async function sendManagerMessage(
  send: (client: HubApiClient) => Promise<void>,
  deps: { withHub?: typeof withHubClient; host?: string } = {},
): Promise<void> {
  const withHub = deps.withHub ?? withHubClient;
  const attempt = (
    opts: Parameters<typeof withHubClient>[0],
  ): Promise<'sent' | 'elsewhere' | undefined> =>
    withHub(opts, async (client) => {
      try {
        await send(client);
        return 'sent' as const;
      } catch (err) {
        if (retryOnLocalHub(err, deps.host)) return 'elsewhere' as const;
        throw err;
      }
    });
  const exitBefore = process.exitCode;
  const first = await attempt(workspaceHub());
  if (first !== 'elsewhere') return;
  // The record hub refused an op only this machine can do. Nothing was printed
  // for that refusal, but a failed target resolution may still have set an exit
  // code; a retry that works clears it.
  const retried = await attempt({ preferLocal: true });
  if (retried === 'sent') process.exitCode = exitBefore;
}

/** Attach to a hub-run manager's tmux session in this terminal (or a new pane). */
async function attachToSession(m: HubApiManager, openIn?: AttachOpenIn): Promise<boolean> {
  if (!m.tmuxSession || !m.attachCommand) {
    log.error(
      `manager ${m.id} runs in a terminal of its own, not in a session the hub can attach to.`,
    );
    return false;
  }
  if (!runsHere(m)) {
    log.error(
      `manager ${m.id} runs on ${m.host}, not on this machine. Reach its session there with:\n  ${m.attachCommand}`,
    );
    return false;
  }
  // `=` is tmux's exact-match prefix: without it a session whose name merely
  // starts with this one would match.
  const target = `=${m.tmuxSession}`;
  if (openIn && openIn !== 'same') {
    const host = detectHostTerminal();
    if (host === 'unknown') {
      log.error('--attach-in needs a supported terminal (tmux, cmux, herdr, iTerm2).');
      return false;
    }
    const spawned = await spawnInNewTerminal({
      host,
      mode: openIn,
      argv: ['tmux', 'attach-session', '-t', target],
      cwd: m.cwd,
      title: 'manager',
    });
    if (!spawned.launched) {
      log.error(spawned.error ?? `could not open a new ${host} ${openIn}`);
      return false;
    }
    log.success(spawned.note || `attached in a new ${host} ${openIn}`);
    return true;
  }
  // Inside tmux already: `attach` would refuse to nest, so switch the client.
  const inTmux = (process.env['TMUX'] ?? '').length > 0;
  const args = inTmux ? ['switch-client', '-t', target] : ['attach-session', '-t', target];
  const r = spawnSync('tmux', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    log.error(`could not attach: tmux ${args.join(' ')} exited ${String(r.status ?? -1)}`);
    return false;
  }
  return true;
}

function mustAttachIn(value: string | undefined): AttachOpenIn | undefined {
  if (value && !['split', 'window', 'tab'].includes(value)) {
    log.error(`--attach-in must be one of split, window, tab`);
    process.exit(4);
  }
  return value as AttachOpenIn | undefined;
}

const listCommand = new Command('list')
  .alias('ls')
  .description('List manager sessions: running first, then the most recently seen')
  .option('-w, --workspace <ref>', 'only this workspace (id or path)')
  .option('--running', 'only running managers')
  .option('-j, --json', 'print the listing as JSON')
  .action(async (opts: WorkspaceOpt & { running?: boolean; json?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const ws = opts.workspace ? await mustResolve(client, opts.workspace) : undefined;
      const managers = await client.listManagers({
        ...(ws ? { workspaceId: ws.id } : {}),
        ...(opts.running ? { status: 'running' as const } : {}),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(managers, null, 2) + '\n');
        return;
      }
      if (managers.length === 0) {
        log.info(
          'no managers yet. Run `agentbox create` or `agentbox tasks add` from a claude or codex session, or `agentbox manager start`.',
        );
        return;
      }
      renderManagers(managers);
    });
  });

const statusCommand = new Command('status')
  .description("Show a manager's state (default: this session's, else the workspace's)")
  .argument('[id]', 'manager id (or a unique prefix)')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('-j, --json', 'print the state as JSON')
  .action(async (id: string | undefined, opts: WorkspaceOpt & { json?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const one = id
        ? await mustManager(client, id)
        : opts.workspace
          ? undefined
          : await currentManager(client);
      if (one) {
        if (opts.json) process.stdout.write(JSON.stringify(one, null, 2) + '\n');
        else printManager(one);
        return;
      }
      const ws = await mustResolve(client, opts.workspace);
      const managers = await client.listWorkspaceManagers(ws.id);
      if (opts.json) {
        process.stdout.write(JSON.stringify(managers, null, 2) + '\n');
        return;
      }
      if (managers.length === 0) {
        log.info(`no managers in ${ws.name} yet.`);
        return;
      }
      renderManagers(managers);
    });
  });

const startCommand = new Command('start')
  .description('Start a manager agent in the workspace folder, in a tmux session the hub runs')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--agent <agent>', `which agent to run (${managerAgents().join(' | ')})`, 'claude')
  .option(
    '--session <id>',
    `resume this agent session (${RESUMABLE_MANAGER_AGENTS.join(' | ')} only)`,
  )
  .option('--new', 'start a fresh session without asking which to resume')
  .option('--restart', 'with --session: restart the hub-run manager holding it if it is running')
  .option('--attach', 'attach to the session once it is up')
  .action(
    async (
      opts: WorkspaceOpt & {
        agent: string;
        session?: string;
        new?: boolean;
        restart?: boolean;
        attach?: boolean;
      },
    ) => {
      const agents = managerAgents();
      if (!agents.includes(opts.agent)) {
        log.error(`unknown agent "${opts.agent}" (expected ${agents.join(', ')})`);
        process.exit(4);
      }
      const ws = await resolveOn(opts.workspace);
      await withHubClient({ preferLocal: true }, async (client) => {
        let sessionId = opts.session;
        // Offer to resume only when the user said neither --session nor --new,
        // and only where a resumable session actually exists.
        if (!sessionId && !opts.new && process.stdout.isTTY) {
          const found = await client.listManagerSessions(ws.id, opts.agent).catch(() => null);
          if (found?.supported && found.sessions.length > 0) {
            const picked = await select({
              message: `Resume a ${opts.agent} session in ${ws.name}?`,
              options: [
                { value: '', label: 'New session' },
                ...found.sessions.map((s) => ({
                  value: s.id,
                  label: s.title,
                  hint: `${s.id.slice(0, 8)} · ${ago(s.updatedAt)}`,
                })),
              ],
            });
            if (isCancel(picked)) {
              log.info('cancelled.');
              return;
            }
            if (picked) sessionId = picked;
          }
        }
        const manager = await client.startManager(ws.id, {
          agent: opts.agent,
          ...(sessionId ? { sessionId } : {}),
          ...(opts.restart ? { restart: true } : {}),
        });
        printManager(manager);
        if (opts.attach && !(await attachToSession(manager))) process.exit(1);
      });
    },
  );

const resumeCommand = new Command('resume')
  .description("Reopen a stopped manager's session in a tmux session the hub runs")
  .argument('<id>', 'manager id (or a unique prefix)')
  .option('--attach', 'attach to the session once it is up')
  .option('--attach-in <mode>', 'with --attach: open in a new split | window | tab')
  .action(async (id: string, opts: { attach?: boolean; attachIn?: string }) => {
    const mode = mustAttachIn(opts.attachIn);
    await withHubClient({ preferLocal: true }, async (client) => {
      const target = await mustManager(client, id);
      const manager = await client.resumeManager(target.id);
      printManager(manager);
      if (opts.attach && !(await attachToSession(manager, mode))) process.exit(1);
    });
  });

const stopCommand = new Command('stop')
  .description('Stop a hub-run manager (a session in your own terminal is yours to exit)')
  .argument('<id>', 'manager id (or a unique prefix)')
  .action(async (id: string) => {
    await withHubClient({ preferLocal: true }, async (client) => {
      const target = await mustManager(client, id);
      printManager(await client.stopManager(target.id));
    });
  });

const attachCommand = new Command('attach')
  .description("Attach to a hub-run manager's terminal session")
  .argument('[id]', 'manager id (default: the one running hub-run manager in the workspace)')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--attach-in <mode>', 'open in a new split | window | tab instead of this terminal')
  .action(async (id: string | undefined, opts: WorkspaceOpt & { attachIn?: string }) => {
    const mode = mustAttachIn(opts.attachIn);
    await withHubClient({ preferLocal: true }, async (client) => {
      let manager: HubApiManager;
      if (id) manager = await mustManager(client, id);
      else {
        const ws = await resolveOn(opts.workspace);
        const running = (await client.listWorkspaceManagers(ws.id)).filter(
          (m) => m.kind === 'tmux' && m.status === 'running',
        );
        if (running.length !== 1) {
          log.error(
            running.length === 0
              ? `no tmux-run manager is running in ${ws.name}. Start one with \`agentbox manager start\`, or resume one with \`agentbox manager resume <id>\`.`
              : `${String(running.length)} tmux-run managers are running in ${ws.name}; pass an id (\`agentbox manager list\`).`,
          );
          process.exit(2);
        }
        manager = running[0]!;
      }
      if (manager.background && !manager.attachCommand) {
        // A Claude background session: the hub opens it in a tmux session of its own.
        manager = await client.attachManager(manager.id);
      }
      if (manager.kind === 'external' && manager.status === 'running' && !manager.attachCommand) {
        log.info(
          `manager ${manager.id} is running in your terminal${manager.pid !== undefined ? ` (pid ${String(manager.pid)})` : ''}; switch to that window.`,
        );
        process.exit(2);
      }
      if (manager.status !== 'running') {
        log.error(
          `manager ${manager.id} is not running. Resume it with \`agentbox manager resume ${manager.id} --attach\`.`,
        );
        process.exit(2);
      }
      if (!(await attachToSession(manager, mode))) process.exit(1);
    });
  });

const sessionsCommand = new Command('sessions')
  .description('List agent sessions in the workspace folder that a manager could resume')
  .option('-w, --workspace <ref>', 'workspace id or path (default: the one containing the cwd)')
  .option('--agent <agent>', 'which agent to list sessions for', 'claude')
  .option('-j, --json', 'print the listing as JSON')
  .action(async (opts: WorkspaceOpt & { agent: string; json?: boolean }) => {
    const ws = await resolveOn(opts.workspace);
    await withHubClient({ preferLocal: true }, async (client) => {
      const found = await client.listManagerSessions(ws.id, opts.agent);
      if (opts.json) {
        process.stdout.write(JSON.stringify(found, null, 2) + '\n');
        return;
      }
      if (!found.supported) {
        log.info(`resuming a ${found.agent} session is not supported yet.`);
        return;
      }
      if (found.sessions.length === 0) {
        log.info(`no ${found.agent} sessions in ${ws.root}.`);
        return;
      }
      renderTable(
        ['id', 'title', 'updated'],
        found.sessions.map((s) => [s.id, s.title, ago(s.updatedAt)]),
      );
    });
  });

const noteCommand = new Command('note')
  .description(
    "Record why the manager did something on the workspace timeline, at this session's turn",
  )
  .argument('<text>', 'the note')
  .argument('[id]', 'manager id or unique prefix (default: the session running this command)')
  .option('--replan', 'mark it as a re-plan: reordering, holding or splitting work')
  .option('--plan', 'mark it as the plan itself')
  .option('-j, --json', 'print the recorded event as JSON')
  .action(
    async (
      text: string,
      id: string | undefined,
      opts: { replan?: boolean; plan?: boolean; json?: boolean },
    ) => {
      if (opts.replan && opts.plan) {
        log.error('pass --replan or --plan, not both');
        process.exit(4);
      }
      await withHubClient(workspaceHub(), async (client) => {
        let managerId: string;
        if (id) managerId = (await mustManager(client, id)).id;
        else {
          const hint = detectHostSession();
          if (!hint) {
            log.error('run inside the manager session, or pass a manager id');
            process.exit(2);
          }
          // Registering is idempotent, and a session that never ran agentbox yet has no record.
          const registered = await registerHostManager(client, hint);
          if (!registered) process.exit(1);
          managerId = registered.managerId;
        }
        const event = await client.addManagerNote(managerId, {
          text,
          ...(opts.replan
            ? { kind: 'replan' as const }
            : opts.plan
              ? { kind: 'plan' as const }
              : {}),
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(event, null, 2) + '\n');
          return;
        }
        log.success(
          `noted on ${managerId}${event.turn !== undefined ? ` at turn ${String(event.turn)}` : ''}`,
        );
      });
    },
  );

const messageCommand = new Command('message')
  .alias('say')
  .description("Type a message into a manager's session and submit it (resuming a stopped one)")
  .argument('<id>', 'manager id (or a unique prefix)')
  .argument('<text>', 'what to type')
  .option('--pr <number>', 'the pull request the message is about')
  .option('--repo <owner/name>', 'with --pr: which repo, when the number is ambiguous')
  .action(async (id: string, text: string, opts: { pr?: string; repo?: string }) => {
    const prNumber = opts.pr === undefined ? undefined : Number(opts.pr);
    if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber < 1)) {
      log.error('--pr must be a pull request number');
      process.exit(4);
    }
    const body = {
      text,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
    };
    await sendManagerMessage(async (client) => {
      const target = await mustManager(client, id);
      const res = await client.sendManagerMessage(target.id, body);
      log.success(
        res.delivered === 'resumed'
          ? `resumed ${res.manager.id} with the message`
          : `typed into ${res.manager.id}`,
      );
    });
  });

const forgetCommand = new Command('forget')
  .alias('rm')
  .description('Forget a stopped manager (its boxes and tasks are untouched)')
  .argument('<id>', 'manager id (or a unique prefix)')
  .option('-y, --yes', 'skip the confirmation')
  .option('--force', 'forget it even if it reads as running (its process is left alone)')
  .action(async (id: string, opts: { yes?: boolean; force?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const target = await mustManager(client, id);
      if (!opts.yes) {
        const answer = await confirm({
          message: `Forget manager ${target.id} (${target.agent} · ${label(target)})?`,
          initialValue: false,
        });
        if (isCancel(answer) || !answer) {
          log.info('cancelled.');
          return;
        }
      }
      await client.removeManager(target.id, { force: Boolean(opts.force) });
      log.success(`forgot ${target.id}`);
    });
  });

export const managerCommand = new Command('manager')
  .alias('managers')
  .description(
    'Agent sessions that create and watch boxes: detected from your terminal, or run by the hub',
  )
  .addCommand(listCommand, { isDefault: true })
  .addCommand(statusCommand)
  .addCommand(startCommand)
  .addCommand(resumeCommand)
  .addCommand(stopCommand)
  .addCommand(attachCommand)
  .addCommand(sessionsCommand)
  .addCommand(noteCommand)
  .addCommand(messageCommand)
  .addCommand(forgetCommand);
