import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';
import {
  BOX_STATUS_EVENT,
  type BoxStatus,
  type BoxStatusClaude,
} from '@agentbox/ctl';
import type { PromptAskEvent } from '@agentbox/relay';
import { ensureRelay, readBoxStatus } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import {
  AGENT_WAIT_STATES,
  derivedAgentState,
  isAgentWaitState,
  matchesAgentWaitState,
  type AgentWaitState,
} from '../lib/wait/agent-state.js';
import {
  answerKeystrokes,
  isTuiId,
  mintTuiId,
  parseTuiId,
  resolveQuestionOption,
  type AgentKind,
  type AnswerStep,
} from '../lib/agent-answer.js';
import { resolveDriveSession } from '../lib/drive/session.js';
import { sendKey, sendLiteral } from '../lib/drive/tmux.js';
import { providerForBox } from '../provider/registry.js';
import { waitForEvent, WaitTimeoutError } from '../lib/wait/events.js';
import { handleLifecycleError } from './_errors.js';

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export const agentCommand = new Command('agent').description(
  'Query and wait on the in-box coding agent\'s state (Claude Code plan-mode end, AskUserQuestion, idle/prompt-ready).',
);

interface BoxRefOpts {
  json?: boolean;
}

const agentStateCommand = new Command('state')
  .description('Print the current claude activity state for a box (or full status with --json).')
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--json', 'emit the full BoxStatusClaude payload as JSON')
  .action(async (boxRef: string | undefined, opts: BoxRefOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const status = await readBoxStatus(box);
      const claude = status?.claude;
      if (opts.json === true) {
        process.stdout.write(JSON.stringify(claude ?? null) + '\n');
        return;
      }
      if (!claude) {
        log.info('no status snapshot yet for this box (hooks may not have fired)');
        return;
      }
      process.stdout.write(statusDisplay(claude) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface WaitForOpts {
  timeout?: string;
  json?: boolean;
}

const agentWaitForCommand = new Command('wait-for')
  .description(`Block until the agent reaches a state. One of: ${AGENT_WAIT_STATES.join(' | ')}.`)
  .argument('<state>', `target state: ${AGENT_WAIT_STATES.join(' | ')}`)
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--timeout <ms>', `wall-clock cap (default: ${String(DEFAULT_WAIT_TIMEOUT_MS)})`)
  .option('--json', 'emit the matched claude payload as JSON')
  .action(async (state: string, boxRef: string | undefined, opts: WaitForOpts) => {
    try {
      if (!isAgentWaitState(state)) {
        log.error(`unknown state '${state}' (one of: ${AGENT_WAIT_STATES.join(', ')})`);
        process.exit(2);
      }
      const target: AgentWaitState = state;
      const box = await resolveBoxOrExit(boxRef);
      const timeoutMs =
        opts.timeout !== undefined ? parsePositiveInt(opts.timeout, '--timeout') : DEFAULT_WAIT_TIMEOUT_MS;

      // Fast path: maybe the box is already in the target state.
      const current = await readBoxStatus(box);
      if (current?.claude && matchesAgentWaitState(current.claude, target)) {
        emitMatch(current.claude, opts.json === true);
        return;
      }

      // Subscribe to relay events. Filter to box-status events for this box,
      // re-check on each push.
      try {
        const claude = await waitForEvent<BoxStatusClaude>(
          (ev) => {
            if (ev.boxId !== box.id) return undefined;
            if (ev.type !== BOX_STATUS_EVENT) return undefined;
            const payload = ev.payload as BoxStatus | undefined;
            if (!payload?.claude) return undefined;
            return matchesAgentWaitState(payload.claude, target) ? payload.claude : undefined;
          },
          { boxId: box.id, timeoutMs },
        );
        emitMatch(claude, opts.json === true);
      } catch (err) {
        if (err instanceof WaitTimeoutError) {
          if (opts.json === true) {
            process.stdout.write(
              JSON.stringify({ matched: false, elapsedMs: err.elapsedMs }) + '\n',
            );
          } else {
            log.error(`agent did not reach '${target}' within ${String(timeoutMs)}ms`);
          }
          process.exit(1);
        }
        throw err;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const agentGetPlanQuestionCommand = new Command('get-plan-question')
  .description("Print the active ExitPlanMode plan body or AskUserQuestion content (whichever is current).")
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--json', 'emit the structured payload as JSON instead of a human render')
  .action(async (boxRef: string | undefined, opts: BoxRefOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const status = await readBoxStatus(box);
      const claude = status?.claude;
      if (opts.json === true) {
        const out = claude?.plan ?? claude?.question ?? null;
        process.stdout.write(JSON.stringify(out) + '\n');
        return;
      }
      if (claude?.plan) {
        process.stdout.write(claude.plan.plan + '\n');
        return;
      }
      if (claude?.question) {
        for (const q of claude.question.questions) {
          process.stdout.write(`${q.question}\n`);
          for (const o of q.options) {
            process.stdout.write(`  - ${o.label}${o.description ? ` — ${o.description}` : ''}\n`);
          }
        }
        return;
      }
      log.info('no pending plan or question for this box');
      process.exit(1);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface ApprovalsOpts {
  json?: boolean;
  wait?: string;
}

const agentApprovalsCommand = new Command('approvals')
  .description(
    'List everything a box is blocked on: relay host-action approvals (git push, cp host<->box, ' +
      'gh PR writes, checkpoint) AND the agent\'s in-TUI prompts (plan approval, question, tool ' +
      'permission). Each row carries an id to pass to `agent approve`.',
  )
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--json', 'emit the pending approvals as a JSON array')
  .option(
    '--wait <ms>',
    'block until at least one approval is pending (or this wall-clock cap elapses), then print',
  )
  .action(async (boxRef: string | undefined, opts: ApprovalsOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const relayUrl = (await ensureRelay()).hostUrl;
      const waitMs =
        opts.wait !== undefined ? parsePositiveInt(opts.wait, '--wait') : undefined;

      let rows = await gatherApprovals(relayUrl, box);
      if (waitMs !== undefined && rows.length === 0) {
        const start = Date.now();
        while (rows.length === 0 && Date.now() - start < waitMs) {
          await sleep(Math.min(500, waitMs - (Date.now() - start)));
          rows = await gatherApprovals(relayUrl, box);
        }
      }

      if (opts.json === true) {
        process.stdout.write(JSON.stringify(rows) + '\n');
        return;
      }
      if (rows.length === 0) {
        log.info('nothing pending for this box (no relay approvals, agent not parked on a prompt)');
        return;
      }
      for (const row of rows) {
        process.stdout.write(approvalDisplay(row) + '\n');
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface ApproveOpts {
  deny?: boolean;
  cancel?: boolean;
  option?: string;
}

const agentApproveCommand = new Command('approve')
  .description(
    'Answer a pending approval by id (see `agent approvals`). The id is a safety token: you answer ' +
      'the exact prompt you inspected, and if a different one has since taken its place the approve ' +
      'is refused. Works for both relay host-action approvals and the agent\'s in-TUI prompts ' +
      '(plan / question / tool permission). Approves by default; --deny rejects.',
  )
  .argument('<id>', 'approval id from `agent approvals` (relay UUID or a tui:... id)')
  .option('--deny', 'reject instead of approving')
  .option('--cancel', 'relay approvals only: dismiss (treated as denied; marks it cancelled)')
  .option(
    '--option <n|label>',
    'in-TUI question/permission: pick this 1-based option (or match its label) instead of the default',
  )
  .action(async (id: string, opts: ApproveOpts) => {
    try {
      if (isTuiId(id)) {
        await approveInTui(id, opts);
        return;
      }
      await approveRelay(id, opts);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** Answer a relay host-action prompt by its UUID (the #60 path). */
async function approveRelay(id: string, opts: ApproveOpts): Promise<void> {
  const relayUrl = (await ensureRelay()).hostUrl;
  const cancelled = opts.cancel === true;
  const answer: 'y' | 'n' = opts.deny === true || cancelled ? 'n' : 'y';
  const url = new URL('/admin/prompts/answer', relayUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, answer, cancelled: cancelled || undefined }),
  });
  // 204 = resolved; 404 = already answered/expired (idempotent — the
  // orchestrator treats both as "done").
  if (res.status === 204) {
    log.success(`approval ${id}: ${answer === 'y' ? 'approved' : 'denied'}`);
    return;
  }
  if (res.status === 404) {
    log.info(`approval ${id} already resolved (or expired)`);
    return;
  }
  log.error(`relay /admin/prompts/answer: HTTP ${String(res.status)}`);
  process.exit(1);
}

/**
 * Answer an in-TUI prompt by its `tui:` id. Verifies the box is STILL parked on
 * the exact prompt the id was minted for (recompute the digest) before sending
 * any keystroke — so a prompt that changed since `approvals` was run is refused,
 * never mis-answered. Then sends the mapped keystrokes to the agent's tmux
 * session via the same helpers `agentbox drive` uses.
 */
async function approveInTui(id: string, opts: ApproveOpts): Promise<void> {
  const parsed = parseTuiId(id);
  if (!parsed) {
    log.error(`malformed in-TUI approval id: ${id}`);
    process.exit(2);
  }
  if (opts.cancel === true) {
    log.error('--cancel applies to relay approvals only; use --deny for in-TUI prompts');
    process.exit(2);
  }
  const box = await resolveBoxOrExit(parsed.boxId);
  const status = await readBoxStatus(box);
  const claude = status?.claude;
  // Race guard: the prompt must still be the one this id was minted for.
  const current = claude ? mintTuiId(box.id, claude) : null;
  if (!current || current.id !== id) {
    log.error(
      `approval ${id} is no longer the pending prompt for ${box.name} ` +
        `(it changed or was answered) — re-run \`agentbox agent approvals ${box.name}\``,
    );
    process.exit(1);
  }

  // Resolve a question's --option (numeric or label) against the live payload.
  let option: number | undefined;
  if (opts.option !== undefined) {
    if (parsed.kind === 'question' && claude) {
      const resolved = resolveQuestionOption(claude, opts.option);
      if (resolved === null) {
        const labels = (claude.question?.questions?.[0]?.options ?? []).map((o) => o.label);
        log.error(`--option '${opts.option}' did not match an option (have: ${labels.join(' | ')})`);
        process.exit(2);
      }
      option = resolved;
    } else {
      const n = Number.parseInt(opts.option, 10);
      if (!Number.isFinite(n) || n < 1) {
        log.error(`--option must be a 1-based number for a ${parsed.kind} prompt (got: ${opts.option})`);
        process.exit(2);
      }
      option = n;
    }
  }

  const provider = await providerForBox(box);
  const session = await resolveDriveSession(provider, box, undefined);
  const agent = agentKindForSession(session.name);
  const steps = answerKeystrokes(agent, parsed.kind, { option, deny: opts.deny });
  await runAnswerSteps(provider, box, session.name, steps);

  const verb = opts.deny === true ? 'denied' : option !== undefined ? `answered (option ${String(option)})` : 'approved';
  log.success(`${parsed.kind} prompt on ${box.name}: ${verb}`);
}

function agentKindForSession(session: string): AgentKind {
  if (session === 'codex') return 'codex';
  if (session === 'opencode') return 'opencode';
  return 'claude';
}

async function runAnswerSteps(
  provider: Awaited<ReturnType<typeof providerForBox>>,
  box: BoxRecord,
  session: string,
  steps: AnswerStep[],
): Promise<void> {
  for (const step of steps) {
    if (step.type === 'literal') await sendLiteral(provider, box, session, step.value);
    else if (step.type === 'key') await sendKey(provider, box, session, step.value);
    else await sleep(step.ms);
  }
}

agentCommand.addCommand(agentStateCommand);
agentCommand.addCommand(agentWaitForCommand);
agentCommand.addCommand(agentGetPlanQuestionCommand);
agentCommand.addCommand(agentApprovalsCommand);
agentCommand.addCommand(agentApproveCommand);

/** A unified pending-approval row — a relay host-action prompt or an in-TUI block. */
type ApprovalRow =
  | {
      id: string;
      kind: 'host-action';
      command?: string;
      argv?: string[];
      cwd?: string;
      message: string;
      detail?: string;
      defaultAnswer?: 'y' | 'n';
    }
  | { id: string; kind: 'plan'; message: string; plan: string }
  | { id: string; kind: 'question'; message: string; options: string[] }
  | { id: string; kind: 'permission'; message: string; state: string };

/** Merge relay host-action prompts with the box's current in-TUI block (if any). */
async function gatherApprovals(relayUrl: string, box: BoxRecord): Promise<ApprovalRow[]> {
  const rows: ApprovalRow[] = [];

  const relay = await fetchRelayApprovals(relayUrl, box.id);
  for (const ev of relay) {
    rows.push({
      id: ev.id,
      kind: 'host-action',
      command: ev.context?.command,
      argv: ev.context?.argv,
      cwd: ev.context?.cwd,
      message: ev.message,
      detail: ev.detail,
      defaultAnswer: ev.defaultAnswer,
    });
  }

  const claude = (await readBoxStatus(box))?.claude;
  const tui = claude ? mintTuiId(box.id, claude) : null;
  if (claude && tui) {
    if (tui.kind === 'plan') {
      rows.push({ id: tui.id, kind: 'plan', message: 'Approve plan?', plan: claude.plan?.plan ?? '' });
    } else if (tui.kind === 'question') {
      const q = claude.question?.questions?.[0];
      rows.push({
        id: tui.id,
        kind: 'question',
        message: q?.question ?? 'Answer question?',
        options: (q?.options ?? []).map((o) => o.label),
      });
    } else {
      rows.push({
        id: tui.id,
        kind: 'permission',
        message: 'Tool-permission prompt (screen-driven; inspect with `agentbox drive snapshot`)',
        state: claude.state,
      });
    }
  }
  return rows;
}

async function fetchRelayApprovals(relayUrl: string, boxId: string): Promise<PromptAskEvent[]> {
  const url = new URL('/admin/prompts', relayUrl);
  url.searchParams.set('boxId', boxId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`relay /admin/prompts: HTTP ${String(res.status)}`);
  const body = (await res.json()) as { prompts?: PromptAskEvent[] };
  return body.prompts ?? [];
}

function approvalDisplay(row: ApprovalRow): string {
  if (row.kind === 'host-action') {
    const cmd = row.command ?? row.message;
    const argv = row.argv?.length ? `  ${row.argv.join(' ')}` : '';
    const detail = row.detail ? `  (${row.detail})` : '';
    return `${row.id}  [host-action] ${cmd}${argv}${detail}`;
  }
  if (row.kind === 'plan') {
    return `${row.id}  [plan] ${firstLine(row.plan)}`;
  }
  if (row.kind === 'question') {
    return `${row.id}  [question] ${row.message}  {${row.options.join(' | ')}}`;
  }
  return `${row.id}  [permission] ${row.message}`;
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0] ?? '';
  return line.length > 100 ? line.slice(0, 99) + '…' : line;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emitMatch(claude: BoxStatusClaude, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(claude) + '\n');
  } else {
    process.stdout.write(derivedAgentState(claude) + '\n');
  }
}

function statusDisplay(claude: BoxStatusClaude): string {
  return derivedAgentState(claude);
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${label} must be a positive integer (got: ${raw})`);
  }
  return n;
}
