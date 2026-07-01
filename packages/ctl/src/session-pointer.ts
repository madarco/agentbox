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
/** Holds the box's current Claude session id (uuid). */
export const CLAUDE_SESSION_POINTER = join(SESSION_POINTER_DIR, 'claude-session');
/** Presence marker: Codex has run in this box (Codex exposes no resumable id). */
export const CODEX_ACTIVE_MARKER = join(SESSION_POINTER_DIR, 'codex-active');

function writePointer(path: string, content: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  } catch {
    // Best-effort: a failed write just means restore won't resume this session.
  }
}

/**
 * Record the box's current Claude session id (pulled from a hook payload's
 * `session_id`). Updates on every capture so `/new`, `/clear`, `/branch` —
 * which mint a new session id — are tracked, not a stale launch-time id.
 */
export function recordClaudeSessionId(id: string): void {
  // Defensive: only accept a uuid-ish token so a malformed payload can't write
  // junk we'd later hand to `claude --resume`.
  if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,}$/.test(id)) return;
  writePointer(CLAUDE_SESSION_POINTER, `${id}\n`);
}

/** Mark that Codex has run in this box (presence-only; resume uses `--last`). */
export function markCodexActive(): void {
  writePointer(CODEX_ACTIVE_MARKER, `${new Date().toISOString()}\n`);
}

function clearPointer(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort: a stale pointer just means restore may relaunch an already-
    // exited agent — annoying, not harmful.
  }
}

/** Drop the Claude pointer when its session ends (no resume target anymore). */
export function clearClaudeSessionPointer(): void {
  clearPointer(CLAUDE_SESSION_POINTER);
}

/** Drop the Codex marker when its session ends. */
export function clearCodexMarker(): void {
  clearPointer(CODEX_ACTIVE_MARKER);
}
