/**
 * Per-box "current agent session" pointers, written lazily from activity hooks.
 *
 * When a box stops (or a cloud sandbox idle-pauses) and is restarted, the host
 * re-launches the agent it was running so attaching looks seamless. To resume
 * the RIGHT conversation it needs the session id — but agent session files live
 * in *shared* config volumes pooled across every box, so a file probe can't tell
 * whose session is whose. Instead we capture the live session id lazily from the
 * agent's own activity hooks and stash it here.
 *
 * Location: `~/.local/state/agentbox/` is on the box's own writable layer — NOT
 * one of the mounted (shared) volumes (`~/.claude`, `~/.codex`, …) — so it is
 * per-box, survives stop/start + cloud pause/resume, and is wiped on destroy.
 * The host reads these files back over `provider.exec` on restart.
 *
 * The pointers are cleared when the agent's tmux session ends (the StatusReporter
 * watches for the running→stopped edge) so a restart only resumes an agent that
 * was actually running when the box went down, not one the user already exited.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SESSION_POINTER_DIR = join(homedir(), '.local', 'state', 'agentbox');

/**
 * How an agent's pointer behaves. Two mechanisms, because two agents genuinely
 * differ: Claude's hooks carry a resumable `session_id`, Codex exposes none and
 * resumes with `--last`, so its pointer is presence-only.
 */
export type SessionPointerKind = 'session-id' | 'presence';

export interface AgentSessionPointer {
  /**
   * FROZEN. Do not change these strings.
   *
   * The WRITER is the `agentbox-ctl` baked into a box's image; the READER is the
   * host CLI, which greps these exact paths over `provider.exec` on restart
   * (`apps/cli/src/agents/{claude,codex}/runtime.ts`). A box created from an
   * older snapshot writes the old name for its whole life, so renaming the path
   * silently costs every existing box its resume-on-restart — and a restored
   * checkpoint too. The SYMBOLS around them are free to change; the values are
   * a wire contract.
   */
  readonly path: string;
  readonly kind: SessionPointerKind;
}

/**
 * The agents that have a pointer at all, keyed by id.
 *
 * A ctl-internal table on purpose: ctl is baked into the image and must never
 * import the agent registry — it learns its agent list from the host over
 * `agents.list`. An agent absent here simply has nothing to record, which is the
 * right default for one added after this image was built.
 *
 * This used to be TWO hand-written tables, one in `commands/agent-state.ts` and
 * one in `status-reporter.ts`, each holding half the fact.
 */
export const AGENT_SESSION_POINTERS: Readonly<Record<string, AgentSessionPointer>> = {
  claude: { path: join(SESSION_POINTER_DIR, 'claude-session'), kind: 'session-id' },
  codex: { path: join(SESSION_POINTER_DIR, 'codex-active'), kind: 'presence' },
};

function writePointer(path: string, content: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  } catch {
    // Best-effort: a failed write just means restore won't resume this session.
  }
}

/**
 * Record an agent's current session id (pulled from a hook payload's
 * `session_id`). Updates on every capture so `/new`, `/clear` and `/branch` —
 * which mint a new id — are tracked, not a stale launch-time one.
 *
 * No-op for an agent with no pointer, or one whose pointer is presence-only.
 */
export function recordAgentSessionId(agent: string, id: string): void {
  const pointer = AGENT_SESSION_POINTERS[agent];
  if (!pointer || pointer.kind !== 'session-id') return;
  // Defensive: only accept a uuid-ish token so a malformed payload can't write
  // junk we'd later hand to `--resume`.
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,}$/.test(id)) return;
  writePointer(pointer.path, `${id}\n`);
}

/**
 * Mark that a presence-only agent has run in this box. No-op for an agent whose
 * pointer carries a real session id, or one with no pointer.
 */
export function markAgentActive(agent: string): void {
  const pointer = AGENT_SESSION_POINTERS[agent];
  if (!pointer || pointer.kind !== 'presence') return;
  writePointer(pointer.path, `${new Date().toISOString()}\n`);
}

/**
 * Drop an agent's pointer when its session ends, so a restart only resumes an
 * agent that was actually running when the box went down — not one the user had
 * already exited.
 */
export function clearAgentSessionPointer(agent: string): void {
  const pointer = AGENT_SESSION_POINTERS[agent];
  if (!pointer) return;
  try {
    rmSync(pointer.path, { force: true });
  } catch {
    // Best-effort: a stale pointer just means restore may relaunch an already-
    // exited agent — annoying, not harmful.
  }
}
