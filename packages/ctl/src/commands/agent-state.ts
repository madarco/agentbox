import { Command } from 'commander';
import { agentState } from '../client.js';
import { clearClaudeSessionPointer, recordClaudeSessionId } from '../session-pointer.js';
import {
  AGENT_ACTIVITY_STATES,
  DEFAULT_SOCKET_PATH,
  type AgentActivityState,
  type AgentPlanPayload,
  type AgentQuestionPayload,
} from '../types.js';
import type { AgentId } from '@agentbox/core';

interface AgentStateOptions {
  socket: string;
  payloadStdin?: boolean;
  clearPending?: boolean;
  captureSession?: boolean;
  clearSession?: boolean;
}

/**
 * Per-box session pointers, so a box restart can resume the conversation that
 * was actually running. Only an agent that exposes a resumable session id can
 * have one — Claude does (its hooks carry `session_id`), Codex does not (the
 * supervisor drops a presence marker instead), OpenCode has no resume at all.
 * An agent absent from this table accepts the capture flags and has nothing to
 * record, which is the right default for a new agent.
 */
const SESSION_POINTERS: Readonly<
  Record<AgentId, { record: (id: string) => void; clear: () => void }>
> = {
  claude: { record: recordClaudeSessionId, clear: clearClaudeSessionPointer },
};

/**
 * The frozen per-agent command names, with the wording each one's help text has
 * always carried. Data, not code: adding an agent does NOT add a row here — a
 * new agent uses `agent-state <id>`. These exist only because hook files already
 * on disk in shared config volumes invoke them by name.
 */
export const LEGACY_AGENT_STATE_COMMANDS: readonly {
  agent: AgentId;
  label: string;
  producer: string;
}[] = [
  { agent: 'claude', label: 'Claude', producer: 'hooks' },
  { agent: 'codex', label: 'Codex', producer: 'hooks' },
  { agent: 'opencode', label: 'OpenCode', producer: 'the plugin' },
];

/**
 * Build a state-reporting command.
 *
 * ONE implementation for every agent. It is exposed twice on purpose:
 *
 *  - `agent-state <agent> <state>` — the generic form. What a new agent uses;
 *    nothing per-agent has to be added to ctl for it to report activity.
 *  - `<agent>-state <state>` — the frozen per-agent names, generated from the
 *    built-in list. These are NOT a courtesy alias: the seeded hook/plugin files
 *    that invoke them live in agent config volumes SHARED BETWEEN BOXES, so a
 *    `hooks.json` written by one box's image can be read by a box running an
 *    older baked ctl. Keeping the names (and leaving the seeded bytes alone)
 *    is what makes that safe in both directions.
 *
 * MUST be non-disruptive: it always exits 0 (even on a bad arg or an
 * unreachable / dead daemon) with a short connect timeout, so an agent's turn is
 * never blocked or failed by a hook.
 *
 * With `--payload-stdin`, also reads the agent's hook JSON from stdin and, for
 * `end-plan` / `question` states, extracts the plan body or the questions array
 * so the host can surface them via `agentbox agent get-plan-question` without
 * scraping the terminal.
 *
 * With `--capture-session`, reads the same hook JSON and records `session_id` to
 * the box's pointer so a restart can resume the exact conversation. Wired onto
 * frequently-firing hooks (SessionStart / Stop) so the pointer tracks `/new` and
 * `/branch`, which mint fresh session ids. `--clear-session` (SessionEnd) drops
 * it synchronously, ahead of the reporter's running->stopped backstop.
 */
export function buildAgentStateCommand(
  spec: { kind: 'generic' } | { kind: 'agent'; agent: AgentId; label: string; producer: string },
): Command {
  const generic = spec.kind === 'generic';
  const cmd = new Command(generic ? 'agent-state' : `${spec.agent}-state`).description(
    generic
      ? 'Report an agent activity state to the box supervisor (used by hooks)'
      : `Report ${spec.label} activity state to the box supervisor (used by ${spec.producer})`,
  );
  if (generic) cmd.argument('<agent>', 'agent id (claude, codex, opencode, ...)');
  cmd
    .argument('<state>', `one of: ${AGENT_ACTIVITY_STATES.join(', ')}`)
    .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
    .option('--payload-stdin', "parse the agent's hook JSON from stdin (pre-tool plan/question)")
    .option('--clear-pending', 'force-clear a sticky end-plan/question state (post-tool cleanup)')
    .option('--capture-session', "record the hook's session_id to the box's session pointer")
    .option('--clear-session', "drop the box's session pointer (SessionEnd)")
    .action(async (...argv: unknown[]) => {
      // commander passes (…args, options, command); the arg count differs
      // between the two forms, so read positionally from the front.
      const agent = generic ? (argv[0] as string) : spec.agent;
      const state = (generic ? argv[1] : argv[0]) as string;
      const opts = (generic ? argv[2] : argv[1]) as AgentStateOptions;
      await reportAgentState(agent, state, opts);
      process.exit(0);
    });
  return cmd;
}

/** The command body, split out so it is reachable from a unit test. */
export async function reportAgentState(
  agent: string,
  state: string,
  opts: AgentStateOptions,
): Promise<void> {
  try {
    if (agent.length === 0) return;
    if (!AGENT_ACTIVITY_STATES.includes(state as AgentActivityState)) return;
    const pointer = SESSION_POINTERS[agent];
    if (opts.clearSession) pointer?.clear();
    const typedState = state as AgentActivityState;
    // Read stdin at most once, shared by both consumers.
    const raw = opts.payloadStdin || opts.captureSession ? await readStdinJson() : null;
    if (opts.captureSession && typeof raw?.session_id === 'string') {
      pointer?.record(raw.session_id);
    }
    const extracted = opts.payloadStdin ? extractPayload(typedState, raw) : undefined;
    const payload: {
      plan?: AgentPlanPayload;
      question?: AgentQuestionPayload;
      clearPending?: boolean;
    } = { ...(extracted ?? {}) };
    if (opts.clearPending) payload.clearPending = true;
    const hasField =
      payload.plan !== undefined ||
      payload.question !== undefined ||
      payload.clearPending !== undefined;
    await agentState(
      { socketPath: opts.socket, timeoutMs: 1500 },
      agent,
      typedState,
      hasField ? payload : undefined,
    );
  } catch {
    // Fire-and-forget: a missing/late daemon must never break an agent hook.
  }
}

interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Agents pass the active session id on every hook's stdin JSON. */
  session_id?: string;
}

/**
 * Pull the relevant slice out of the agent's hook JSON. Intentionally
 * defensive — a future schema change should silently degrade to "state-only,
 * no payload" rather than crash the hook chain.
 */
function extractPayload(
  state: AgentActivityState,
  raw: HookPayload | null,
): { plan?: AgentPlanPayload; question?: AgentQuestionPayload } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tool = raw.tool_input ?? {};
  const capturedAt = new Date().toISOString();

  if (state === 'end-plan' && typeof tool.plan === 'string') {
    const plan: AgentPlanPayload = { plan: tool.plan, capturedAt };
    return { plan };
  }
  if (state === 'question' && Array.isArray(tool.questions)) {
    const questions = (tool.questions as unknown[])
      .map((q) => normalizeQuestion(q))
      .filter((q): q is NonNullable<ReturnType<typeof normalizeQuestion>> => q !== null);
    if (questions.length === 0) return undefined;
    const question: AgentQuestionPayload = { questions, capturedAt };
    return { question };
  }
  return undefined;
}

function normalizeQuestion(raw: unknown): {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.question !== 'string') return null;
  const opts = Array.isArray(q.options) ? (q.options as unknown[]) : [];
  const options = opts
    .map((o) => {
      if (!o || typeof o !== 'object') return null;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== 'string') return null;
      const entry: { label: string; description?: string } = { label: oo.label };
      if (typeof oo.description === 'string') entry.description = oo.description;
      return entry;
    })
    .filter((o): o is { label: string; description?: string } => o !== null);
  const out: ReturnType<typeof normalizeQuestion> = { question: q.question, options };
  if (typeof q.header === 'string') out!.header = q.header;
  if (typeof q.multiSelect === 'boolean') out!.multiSelect = q.multiSelect;
  return out;
}

/**
 * Read stdin to EOF with a small wall-clock cap (1s). When stdin is a TTY or
 * empty (some hooks fire without a payload), resolve with null instead of
 * blocking forever.
 */
function readStdinJson(): Promise<HookPayload | null> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    const cap = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(null);
    }, 1000);
    cap.unref();
    process.stdin.on('data', (b: Buffer) => chunks.push(b));
    process.stdin.on('end', () => {
      clearTimeout(cap);
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookPayload);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(cap);
      resolve(null);
    });
  });
}
