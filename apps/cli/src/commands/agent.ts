import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';
import { type BoxStatusClaude } from '@agentbox/ctl';
import { readBoxStatus } from '@agentbox/sandbox-docker';
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
import { withOwningHub } from '../control-plane/with-hub.js';
import { resolveBoxPromptSource, type BoxPromptSource } from '../control-plane/box-plane.js';
import { resolveHubApiClient } from './control-plane.js';
import { HubApiError } from '../control-plane/hub-api-client.js';
import { loadEffectiveConfig } from '@agentbox/config';
import { remoteHubConfigured } from '../control-plane/remote-hub.js';
import { handleLifecycleError } from './_errors.js';

const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export const agentCommand = new Command('agent').description(
  "Query and wait on the in-box coding agent's state (Claude Code plan-mode end, AskUserQuestion, idle/prompt-ready).",
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
      // The status snapshot lives on whichever hub owns the box (its relay writes
      // status.json), so read it through the owning hub — a box on a control box
      // has no snapshot on this laptop's disk. not-found → no snapshot (same as a
      // null claude below).
      const claude = await fetchAgentClaude(box);
      if (claude === HUB_ERROR) return; // withHubClient reported + set the exit code
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
        opts.timeout !== undefined
          ? parsePositiveInt(opts.timeout, '--timeout')
          : DEFAULT_WAIT_TIMEOUT_MS;

      // Poll the box's agent snapshot through the owning hub until it reaches the
      // target state (or the timeout elapses). Polling — not an event subscription
      // — because `/api/v1` carries no agent-event stream; the command's own docs
      // already sanction it, and `agent approvals --wait` polls the same way. One
      // withOwningHub call wraps the whole loop so the owner-first + not_found
      // retry happens once, not per poll.
      let matched: BoxStatusClaude | undefined;
      let elapsedMs = 0;
      const r = await withOwningHub(box, async (client) => {
        const start = Date.now();
        for (;;) {
          const claude = (await client.getAgentState(box.id)).claude as BoxStatusClaude | null;
          if (claude && matchesAgentWaitState(claude, target)) {
            matched = claude;
            return;
          }
          elapsedMs = Date.now() - start;
          if (elapsedMs >= timeoutMs) return;
          await sleep(Math.min(500, timeoutMs - elapsedMs));
        }
      });
      if (r === undefined) return; // hub error; withHubClient reported + set exit code
      if (r === 'not-found') {
        log.error(`box ${box.name} was not found on any hub AgentBox knows.`);
        process.exit(2);
      }
      if (matched) {
        emitMatch(matched, opts.json === true);
        return;
      }
      if (opts.json === true) {
        process.stdout.write(JSON.stringify({ matched: false, elapsedMs }) + '\n');
      } else {
        log.error(`agent did not reach '${target}' within ${String(timeoutMs)}ms`);
      }
      process.exit(1);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const agentGetPlanQuestionCommand = new Command('get-plan-question')
  .description(
    'Print the active ExitPlanMode plan body or AskUserQuestion content (whichever is current).',
  )
  .argument('[box]', 'box ref (default: only box in this project)')
  .option('--json', 'emit the structured payload as JSON instead of a human render')
  .action(async (boxRef: string | undefined, opts: BoxRefOpts) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const claude = await fetchAgentClaude(box);
      if (claude === HUB_ERROR) return; // withHubClient reported + set the exit code
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
      "gh PR writes, checkpoint) AND the agent's in-TUI prompts (plan approval, question, tool " +
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
      // A box created against a control box parks its host-action approvals
      // THERE, not on this laptop's hub — ask the one it actually registered
      // with, or a blocked box reads as "nothing pending". Resolving the source
      // brings up the local hub when the box answers here (its `/api/v1` is what
      // this reads); a control-plane box's mailbox is the remote hub.
      const source = await resolveBoxPromptSource(box);
      if (!source) {
        log.error("Could not reach a hub to read this box's approvals.");
        process.exit(1);
      }
      const waitMs = opts.wait !== undefined ? parsePositiveInt(opts.wait, '--wait') : undefined;

      let gathered = await gatherApprovals(source, box);
      if (waitMs !== undefined && gathered.rows.length === 0) {
        const start = Date.now();
        while (gathered.rows.length === 0 && Date.now() - start < waitMs) {
          await sleep(Math.min(500, waitMs - (Date.now() - start)));
          gathered = await gatherApprovals(source, box);
        }
      }
      const rows = gathered.rows;

      if (opts.json === true) {
        // Array shape is a contract (orchestration reads it) — keep stdout pure
        // and put the degraded-mailbox warning on stderr.
        if (gathered.relayError !== undefined) {
          process.stderr.write(
            `warning: could not read the ${source.remote ? 'control box' : 'hub'} approval mailbox (${gathered.relayError}); host-action rows may be missing\n`,
          );
        }
        process.stdout.write(JSON.stringify(rows) + '\n');
        if (gathered.relayError !== undefined) process.exitCode = 1;
        return;
      }
      if (gathered.relayError !== undefined) {
        // The in-TUI rows below are still trustworthy — they come from the box's
        // own status — so show them, but never let a missing mailbox read as
        // "nothing pending".
        log.warn(
          `could not read the ${source.remote ? 'control box' : 'hub'} approval mailbox (${gathered.relayError}) — ` +
            'host-action approvals are not shown.',
        );
        process.exitCode = 1;
      }
      if (rows.length === 0) {
        // Don't claim "nothing pending" when we couldn't actually reach the
        // mailbox — an empty list is only meaningful if we got an answer.
        if (source.unauthenticatedPlane !== undefined) {
          log.warn(
            `this box's approvals live on ${source.unauthenticatedPlane}, but no hub API key is available here — ` +
              'set AGENTBOX_HUB_API_KEY (or run `agentbox hub setup`) to see them.',
          );
          process.exitCode = 1;
          return;
        }
        if (gathered.relayError === undefined) {
          log.info(
            'nothing pending for this box (no host-action approvals, agent not parked on a prompt)',
          );
        }
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
      "is refused. Works for both relay host-action approvals and the agent's in-TUI prompts " +
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

/**
 * Answer a host-action prompt by its UUID (the #60 path) over the hub `/api/v1`.
 *
 * Unlike `approvals`, this takes only an id — no box to resolve a plane from.
 * Prompt ids are UUIDs, so trying both hubs is unambiguous: the local hub first
 * (the common case; auto-started so `/api/v1/approvals/:id/answer` is available),
 * then the configured control box, which is where a hub box's approvals actually
 * live. Without the fallback, answering a hub box's prompt from the CLI is
 * simply impossible.
 *
 * `--cancel` marks a dismissal distinctly from a plain deny in the audit trail;
 * it still resolves the parked action as not-approved.
 */
async function approveRelay(id: string, opts: ApproveOpts): Promise<void> {
  const cancelled = opts.cancel === true;
  const answer: 'y' | 'n' = opts.deny === true || cancelled ? 'n' : 'y';
  const label = answer === 'y' ? 'approved' : 'denied';

  // Track whether we actually reached a hub: a `not_found` from a hub we DID
  // reach means the prompt is genuinely gone, but never reaching one (local hub
  // couldn't start, control box unreachable) is not evidence it's resolved —
  // claiming so would send the operator looking for the wrong problem.
  let reachedHub = false;

  // Local hub first (auto-started — a bare relay can't serve /api/v1). `not_found`
  // means the prompt isn't here; fall through to the configured control box.
  const localClient = await resolveHubApiClient(undefined, { preferLocal: true });
  if (localClient) {
    reachedHub = true;
    try {
      await localClient.answerApproval(id, answer, cancelled);
      log.success(`approval ${id}: ${label}`);
      return;
    } catch (err) {
      if (!(err instanceof HubApiError && err.code === 'not_found')) throw err;
    }
  }

  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  if (cfg && remoteHubConfigured(cfg.effective)) {
    const remoteClient = await resolveHubApiClient(undefined, { quiet: true });
    if (!remoteClient) {
      // A control box we can't ask is not evidence the prompt is gone.
      log.error(
        `not found on this host's hub, and the control box could not be asked (no API key).\n` +
          'Set AGENTBOX_HUB_API_KEY (or run `agentbox hub setup`), or answer it with `agentbox hub approvals answer`.',
      );
      process.exit(1);
    }
    reachedHub = true;
    try {
      await remoteClient.answerApproval(id, answer, cancelled);
      log.success(`approval ${id}: ${label} (on the control box)`);
      return;
    } catch (err) {
      if (err instanceof HubApiError && err.code === 'not_found') {
        log.info(`approval ${id} already resolved (or expired)`);
        return;
      }
      throw err;
    }
  }
  if (!reachedHub) {
    // The local hub couldn't be started/authenticated and no control box is
    // configured — we never asked anyone, so don't imply the prompt is gone.
    log.error(
      `could not reach a hub to answer approval ${id} (the local hub failed to start). Start it with \`agentbox hub\` and retry.`,
    );
    process.exit(1);
  }
  log.info(`approval ${id} already resolved (or expired)`);
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
        log.error(
          `--option '${opts.option}' did not match an option (have: ${labels.join(' | ')})`,
        );
        process.exit(2);
      }
      option = resolved;
    } else {
      const n = Number.parseInt(opts.option, 10);
      if (!Number.isFinite(n) || n < 1) {
        log.error(
          `--option must be a 1-based number for a ${parsed.kind} prompt (got: ${opts.option})`,
        );
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

  const verb =
    opts.deny === true
      ? 'denied'
      : option !== undefined
        ? `answered (option ${String(option)})`
        : 'approved';
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

interface GatheredApprovals {
  rows: ApprovalRow[];
  /** Set when the relay mailbox couldn't be read; its rows are missing, not absent. */
  relayError?: string;
}

/**
 * Merge the hub's host-action approvals with the box's current in-TUI block (if
 * any).
 *
 * The hub half is allowed to fail without taking the command down. For a local
 * box it is a loopback `/api/v1` call; for a hub box it is a WAN request to the
 * control box, and a blip there must not hide the in-TUI plan/question/permission
 * rows, which come from the box's own status and are entirely independent.
 * `listApprovals` returns every box's pending approvals; filter to this box.
 */
async function gatherApprovals(
  source: BoxPromptSource,
  box: BoxRecord,
): Promise<GatheredApprovals> {
  const rows: ApprovalRow[] = [];
  let relayError: string | undefined;

  try {
    const approvals = await source.client.listApprovals();
    for (const ev of approvals) {
      if (ev.boxId !== box.id) continue;
      rows.push({
        id: ev.id,
        kind: 'host-action',
        command: ev.command,
        argv: ev.argv,
        cwd: ev.cwd,
        message: ev.message,
        detail: ev.detail,
        defaultAnswer: ev.defaultAnswer,
      });
    }
  } catch (err) {
    relayError = err instanceof Error ? err.message : String(err);
  }

  const claude = (await readBoxStatus(box))?.claude;
  const tui = claude ? mintTuiId(box.id, claude) : null;
  if (claude && tui) {
    if (tui.kind === 'plan') {
      rows.push({
        id: tui.id,
        kind: 'plan',
        message: 'Approve plan?',
        plan: claude.plan?.plan ?? '',
      });
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
  return { rows, relayError };
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

/** Sentinel: `withOwningHub` already reported a hub error + set the exit code. */
const HUB_ERROR = Symbol('hub-error');

/**
 * Read the box's Claude status snapshot through the hub that owns it. Returns the
 * snapshot (or null when the box is known but has no snapshot yet, OR when no hub
 * owns it — both surface to the caller as "no snapshot"), or {@link HUB_ERROR}
 * when the hub call failed (already reported).
 */
async function fetchAgentClaude(
  box: BoxRecord,
): Promise<BoxStatusClaude | null | typeof HUB_ERROR> {
  let claude: BoxStatusClaude | null = null;
  const r = await withOwningHub(box, async (client) => {
    claude = ((await client.getAgentState(box.id)).claude ?? null) as BoxStatusClaude | null;
  });
  if (r === undefined) return HUB_ERROR;
  return claude;
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
