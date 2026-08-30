import { intro, isCancel, log, outro, select } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import { CONTAINER_USER, type BoxRecord } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { execa } from 'execa';
import { reattachRef, resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { ATTACH_IN_HELP, INLINE_HELP, resolveAttachInOption } from './_attach-in.js';
import { hostAwareOpenIn } from '../terminal/host.js';
import { cloudAgentAttach } from './_cloud-attach.js';
import { handleLifecycleError } from './_errors.js';
import type { AgentId } from '@agentbox/core';
import { agentIds } from '@agentbox/sandbox-core';
import { agentCommandEntry } from '../agents/commands.js';

const AGENT_KINDS: readonly AgentId[] = agentIds();

const AGENT_KIND_SET = new Set<string>(AGENT_KINDS);

/**
 * Tie-break order when a box has several live agent sessions: registry order,
 * which puts claude first. Derived rather than a literal map so an agent added
 * to the registry is ranked instead of silently landing at rank `undefined`.
 */
function agentPriority(kind: AgentId): number {
  const i = AGENT_KINDS.indexOf(kind);
  return i === -1 ? AGENT_KINDS.length : i;
}

interface LiveAgentSession {
  kind: AgentId;
  sessionName: string;
  /** Unix seconds from tmux `#{session_created}`, or null if unparseable. */
  startedAt: number | null;
}

interface AttachOpts {
  sessionName?: string;
  attachIn?: string;
  inline?: boolean;
}

/**
 * Parse `tmux list-sessions -F '#{session_name} #{session_created}'` stdout
 * into the agent sessions we care about. Pure-string so it's testable without
 * tmux/docker fixtures.
 *
 * `filterName`: when set, keep only the row whose `session_name` strictly
 * equals it. When unset, keep rows whose `session_name` is one of claude /
 * codex / opencode (the agent-default tmux names; any shell or app sessions
 * are ignored).
 */
export function parseTmuxAgentSessions(stdout: string, filterName?: string): LiveAgentSession[] {
  const out: LiveAgentSession[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const sp = line.indexOf(' ');
    const name = sp === -1 ? line : line.slice(0, sp);
    const tsRaw = sp === -1 ? '' : line.slice(sp + 1).trim();
    if (filterName !== undefined) {
      if (name !== filterName) continue;
    } else if (!AGENT_KIND_SET.has(name)) {
      continue;
    }
    const parsed = Number.parseInt(tsRaw, 10);
    const startedAt = Number.isFinite(parsed) ? parsed : null;
    // When --session-name overrides to a non-default tmux name, we can't infer
    // the agent binary from the name alone — default to claude (the
    // per-agent commands work the same way: the binary is fixed by the
    // command they're under). Default-name rows map kind=name directly.
    const kind: AgentId = AGENT_KIND_SET.has(name) ? name : 'claude';
    out.push({ kind, sessionName: name, startedAt });
  }
  return out;
}

async function probeDockerAgentSessions(
  container: string,
  filterName?: string,
): Promise<LiveAgentSession[]> {
  const r = await execa(
    'docker',
    [
      'exec',
      '--user',
      CONTAINER_USER,
      container,
      'tmux',
      'list-sessions',
      '-F',
      '#{session_name} #{session_created}',
    ],
    { reject: false },
  );
  if (r.exitCode !== 0) return [];
  return parseTmuxAgentSessions(r.stdout, filterName);
}

async function probeCloudAgentSessions(
  box: BoxRecord,
  filterName?: string,
): Promise<LiveAgentSession[]> {
  try {
    const provider = await providerForBox(box);
    const r = await provider.exec(box, [
      'tmux',
      'list-sessions',
      '-F',
      '#{session_name} #{session_created}',
    ]);
    if (r.exitCode !== 0) return [];
    return parseTmuxAgentSessions(r.stdout, filterName);
  } catch {
    return [];
  }
}

/** "5m ago" / "3h ago" / "just now"; `unknown` when no timestamp. */
function relativeStartedAt(startedAt: number | null): string {
  if (startedAt === null) return 'unknown';
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, nowSec - startedAt);
  if (delta < 30) return 'just now';
  if (delta < 3600) return `${String(Math.floor(delta / 60))}m ago`;
  if (delta < 86400) return `${String(Math.floor(delta / 3600))}h ago`;
  return `${String(Math.floor(delta / 86400))}d ago`;
}

/**
 * Decide which live agent session to attach to. On a TTY with 2+ candidates,
 * prompt the user. Non-TTY (or piped stdin/stdout) falls back to the most
 * recently started session; tie on null timestamps falls back to the
 * claude > codex > opencode display order.
 *
 * Returns `null` only when the user cancels the picker (caller exits 0).
 */
async function pickSession(
  boxName: string,
  sessions: LiveAgentSession[],
): Promise<LiveAgentSession | null> {
  if (sessions.length === 1) return sessions[0]!;
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!tty) {
    const sorted = [...sessions].sort((a, b) => {
      const sa = a.startedAt ?? -1;
      const sb = b.startedAt ?? -1;
      if (sb !== sa) return sb - sa;
      return agentPriority(a.kind) - agentPriority(b.kind);
    });
    return sorted[0]!;
  }
  const ordered = [...sessions].sort((a, b) => agentPriority(a.kind) - agentPriority(b.kind));
  const picked = await select<LiveAgentSession>({
    message: `Multiple agent sessions in ${boxName}. Attach to:`,
    options: ordered.map((s) => ({
      value: s,
      label: s.kind,
      hint: `started ${relativeStartedAt(s.startedAt)}`,
    })),
  });
  if (isCancel(picked)) {
    outro('cancelled');
    return null;
  }
  return picked;
}

async function dispatchDocker(
  box: BoxRecord,
  winner: LiveAgentSession,
  openIn: ReturnType<typeof resolveAttachInOption>,
): Promise<void> {
  const ref = reattachRef(box);
  // Each wrapper ends in process.exit; the void return is what TS sees
  // because awaiting Promise<never> doesn't terminate control flow at the
  // type level.
  const entry = agentCommandEntry(winner.kind);
  // With `AgentId` open this dispatch is not exhaustive: an agent the session
  // probe accepts (it reads `agentIds()`) but that has no command module used to
  // fall through and return, so `attach` exited 0 having attached to nothing.
  // `agent-command-coverage.test.ts` keeps the table matching the registry; this
  // is the run-time half.
  if (!entry) throw new Error(`attach: no wrapper registered for agent '${winner.kind}'`);
  await entry.attachWrapped(box, winner.sessionName, ref, undefined, openIn);
}

/**
 * Probe the box's live agent tmux sessions, pick one (prompt on a TTY when
 * several), and attach to it — the shared body of `agentbox attach` and the
 * attach tail of `agentbox recover`. Returns 'none' when no session is running
 * (caller decides whether that's an error) and 'cancelled' when the user
 * dismisses the multi-session picker. Otherwise it does not return (each attach
 * wrapper ends in process.exit / blocks on the PTY).
 */
export async function attachToRunningAgent(
  box: BoxRecord,
  opts: AttachOpts,
): Promise<'none' | 'cancelled' | void> {
  const isCloud = (box.provider ?? 'docker') !== 'docker';
  const sessions = isCloud
    ? await probeCloudAgentSessions(box, opts.sessionName)
    : await probeDockerAgentSessions(box.container, opts.sessionName);
  if (sessions.length === 0) return 'none';
  const winner = await pickSession(box.name, sessions);
  if (winner === null) return 'cancelled';

  if (isCloud) {
    // Loading the effective config here only to read `attach.openIn`.
    // The pre-probe above is the ONLY thing preventing auto-start on the
    // cloud branch: `cloudAgentAttach` calls `provider.buildAttach(box,
    // 'agent', { sessionName, command })`, which CREATES the tmux session
    // if it doesn't exist. Don't move the empty-session guard below this
    // line.
    const attachIn = resolveAttachInOption(opts);
    const cfg = await loadEffectiveConfig(box.workspacePath, {
      cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
    });
    await cloudAgentAttach({
      box,
      binary: winner.kind,
      sessionName: winner.sessionName,
      mode: winner.kind,
      openIn: hostAwareOpenIn(cfg),
    });
    return;
  }

  const attachIn = resolveAttachInOption(opts);
  const cfg = await loadEffectiveConfig(box.workspacePath, {
    cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
  });
  await dispatchDocker(box, winner, hostAwareOpenIn(cfg));
}

export const attachCommand = new Command('attach')
  .description(
    'Attach to the running agent tmux session in a box (claude / codex / opencode). Does not auto-start: if no session is running, exits non-zero with a bare warning. With multiple live sessions, prompts on a TTY and picks the most recently started otherwise.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option(
    '--session-name <name>',
    'tmux session name to scan for (default: scan claude/codex/opencode)',
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .action(async function (this: Command, idOrName: string | undefined) {
    const opts = this.optsWithGlobals() as AttachOpts;
    intro('Attaching to agent session...');
    try {
      const box = await resolveBoxOrExit(idOrName);
      const result = await attachToRunningAgent(box, opts);
      if (result === 'none') {
        log.warn(`no agent session running in ${box.name}`);
        process.exit(1);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
