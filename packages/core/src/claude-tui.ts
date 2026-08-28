/**
 * Which terminal renderer Claude Code uses inside a box, as environment.
 *
 * Claude Code's `fullscreen` renderer (alternate screen + virtualised
 * scrollback) repaints differentially — it skips cells it believes are already
 * blank. Over a network transport that assumption breaks down: stale characters
 * are left behind in the blank regions, which is why the corruption shows up in
 * the *gaps* of the text (the two-space indent of an agent reply is the widest
 * gap, so it reads as "the first two columns are garbled"). Nothing repaints
 * those cells afterwards, so the debris survives until something forces a full
 * redraw — hence "resizing the terminal fixes it".
 *
 * Reported upstream behaviour, not an AgentBox bug: `agentbox shell` is clean,
 * and so is Claude Code with `/tui default`. Until it is fixed upstream, boxes
 * pin the classic renderer.
 *
 * The two variables are Claude Code's own overrides (verified against the
 * shipped binary, v2.1.250); they take precedence over the `tui` key in
 * `~/.claude/settings.json`, so this holds regardless of what a box's settings
 * volume happens to carry.
 */

/** Terminal renderer for the in-box Claude Code. Mirrors config `box.claudeTui`. */
export type ClaudeTuiMode = 'default' | 'fullscreen' | 'auto';

/**
 * Environment that pins `mode`, for `/etc/agentbox/box.env`.
 *
 * `auto` returns nothing: no override, Claude Code decides. Callers write these
 * into the box env file rather than only onto the agent's launch command, so a
 * `claude` started by hand from `agentbox shell` gets the same renderer as the
 * one AgentBox starts.
 */
export function claudeTuiEnv(mode: ClaudeTuiMode): Record<string, string> {
  if (mode === 'default') return { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' };
  if (mode === 'fullscreen') return { CLAUDE_CODE_NO_FLICKER: '1' };
  return {};
}
