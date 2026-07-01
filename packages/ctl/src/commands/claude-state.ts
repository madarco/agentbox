import { Command } from 'commander';
import { claudeState } from '../client.js';
import { clearClaudeSessionPointer, recordClaudeSessionId } from '../session-pointer.js';
import {
  CLAUDE_ACTIVITY_STATES,
  DEFAULT_SOCKET_PATH,
  type ClaudeActivityState,
  type ClaudePlanPayload,
  type ClaudeQuestionPayload,
} from '../types.js';

interface ClaudeStateOptions {
  socket: string;
  payloadStdin?: boolean;
  clearPending?: boolean;
  captureSession?: boolean;
  clearSession?: boolean;
}

/**
 * Report Claude Code activity to the box supervisor. Invoked by Claude Code
 * hooks baked into the box image's managed settings. This MUST be
 * non-disruptive: it always exits 0 (even on a bad arg or an unreachable /
 * dead daemon) and uses a short connect timeout, so a Claude turn is never
 * blocked or failed by a hook.
 *
 * With `--payload-stdin`, also reads Claude Code's hook JSON from stdin and,
 * for `end-plan` / `question` states, extracts the plan body or the questions
 * array so the host can surface them via `agentbox agent get-plan-question`
 * without scraping the terminal.
 *
 * With `--capture-session`, reads the same hook JSON and records `session_id`
 * to a per-box pointer (see session-pointer.ts) so a box restart can resume the
 * exact conversation. Wired onto frequently-firing hooks (SessionStart / Stop)
 * so the pointer tracks `/new` and `/branch`, which mint fresh session ids.
 *
 * With `--clear-session` (SessionEnd), drops that pointer synchronously so a
 * restart won't resume a session the user already ended. The StatusReporter's
 * running→stopped edge is the backstop for ends that skip the hook (a kill /
 * crash), but this avoids the up-to-15s race where the box is stopped before
 * the next status snapshot.
 */
export const claudeStateCommand = new Command('claude-state')
  .description('Report Claude activity state to the box supervisor (used by hooks)')
  .argument('<state>', `one of: ${CLAUDE_ACTIVITY_STATES.join(', ')}`)
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option('--payload-stdin', "parse Claude Code's hook JSON from stdin (PreToolUse plan/question)")
  .option('--clear-pending', 'force-clear a sticky end-plan/question state (PostToolUse cleanup)')
  .option('--capture-session', "record the hook's session_id to the box's session pointer")
  .option('--clear-session', "drop the box's session pointer (SessionEnd)")
  .action(async (state: string, opts: ClaudeStateOptions) => {
    try {
      if (!CLAUDE_ACTIVITY_STATES.includes(state as ClaudeActivityState)) {
        process.exit(0);
      }
      if (opts.clearSession) clearClaudeSessionPointer();
      const typedState = state as ClaudeActivityState;
      // Read stdin at most once, shared by both consumers.
      const raw = opts.payloadStdin || opts.captureSession ? await readStdinJson() : null;
      if (opts.captureSession && typeof raw?.session_id === 'string') {
        recordClaudeSessionId(raw.session_id);
      }
      const extracted = opts.payloadStdin ? extractPayload(typedState, raw) : undefined;
      const payload: {
        plan?: ClaudePlanPayload;
        question?: ClaudeQuestionPayload;
        clearPending?: boolean;
      } = { ...(extracted ?? {}) };
      if (opts.clearPending) payload.clearPending = true;
      const hasField =
        payload.plan !== undefined ||
        payload.question !== undefined ||
        payload.clearPending !== undefined;
      await claudeState(
        { socketPath: opts.socket, timeoutMs: 1500 },
        typedState,
        hasField ? payload : undefined,
      );
    } catch {
      // Fire-and-forget: a missing/late daemon must never break a Claude hook.
    }
    process.exit(0);
  });

interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Claude Code passes the active session id on every hook's stdin JSON. */
  session_id?: string;
}

/**
 * Pull the relevant slice out of Claude Code's hook JSON. We're intentionally
 * defensive — a future schema change should silently degrade to "state-only,
 * no payload" rather than crash the hook chain.
 */
function extractPayload(
  state: ClaudeActivityState,
  raw: HookPayload | null,
): { plan?: ClaudePlanPayload; question?: ClaudeQuestionPayload } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tool = raw.tool_input ?? {};
  const capturedAt = new Date().toISOString();

  if (state === 'end-plan' && typeof tool.plan === 'string') {
    const plan: ClaudePlanPayload = { plan: tool.plan, capturedAt };
    return { plan };
  }
  if (state === 'question' && Array.isArray(tool.questions)) {
    const questions = (tool.questions as unknown[])
      .map((q) => normalizeQuestion(q))
      .filter((q): q is NonNullable<ReturnType<typeof normalizeQuestion>> => q !== null);
    if (questions.length === 0) return undefined;
    const question: ClaudeQuestionPayload = { questions, capturedAt };
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
