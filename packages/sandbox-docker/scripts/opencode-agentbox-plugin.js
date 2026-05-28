// AgentBox state-reporting plugin for OpenCode (sst/opencode).
//
// Subscribes to OpenCode's plugin event bus and reports each lifecycle
// transition to `agentbox-ctl opencode-state <state>`. The ctl daemon then
// publishes the state to the host relay's status.json, which is what
// `agentbox agent state` / `agent wait-for` consume on the host side.
//
// Fire-and-forget — a missing/late `agentbox-ctl` must never disturb the
// OpenCode session. The spawned process is detached + unrefed so a slow
// ctl response never blocks an event handler.
//
// Seeded by `seedOpencodePlugin` (packages/sandbox-docker/src/opencode.ts)
// from the image-baked copy at /usr/local/share/agentbox/opencode-plugin/
// into the box's `$OPENCODE_CONFIG_DIR/plugins/agentbox-state.js` on every
// create / start. Idempotent overwrite.
//
// Event coverage (mirrors the Claude / Codex state machine):
//   working   — agent is generating. Driven by `message.part.delta` (streamed
//               tokens) — these fire only DURING active generation, never after
//               the turn ends, so they don't fight the `session.idle` end
//               signal. (Empirically `tool.execute.before` does NOT reach the
//               plugin event bus in opencode 1.15, and `message.updated` fires
//               once AFTER `session.idle` — so neither is safe to map to
//               working.)
//   idle      — turn complete / ready for input (`session.idle`, plus
//               `session.created` as a baseline at session start).
//   waiting   — user input required (`permission.asked`).
//   error     — `session.error`.
//   compacting — opencode has no PreCompact event; `session.compacted` fires
//                AFTER compaction completes, so it maps to `working` (the next
//                event supersedes) rather than `compacting`.
//
// The plugin shape comes from https://opencode.ai/docs/plugins/ — `event` is
// a single handler that receives `{ event }` with a `type` field. Multiple
// exports = multiple plugin functions; we ship one.

import { spawn } from 'node:child_process';

const EVENT_TO_STATE = {
  'session.created': 'idle',
  'session.idle': 'idle',
  'session.error': 'error',
  'session.compacted': 'working',
  'permission.asked': 'waiting',
  'permission.replied': 'working',
  'message.part.delta': 'working',
  // tool.execute.before kept as a defensive mapping — harmless if a future
  // opencode build starts surfacing it (it doesn't today).
  'tool.execute.before': 'working',
};

// Dedupe: `message.part.delta` fires dozens of times per streamed turn. Only
// spawn agentbox-ctl when the mapped state actually changes, so a turn costs
// ~2 spawns (working on the first delta, idle on session.idle) instead of ~50.
let lastState = null;

function pushState(state) {
  if (!state || state === lastState) return;
  lastState = state;
  try {
    const p = spawn('agentbox-ctl', ['opencode-state', state], {
      stdio: 'ignore',
      detached: true,
    });
    p.unref();
  } catch {
    // Fire-and-forget. A missing agentbox-ctl bin (test env, older box image)
    // must not throw out of this handler.
  }
}

export const AgentboxStatePlugin = async () => ({
  event: async ({ event }) => {
    pushState(EVENT_TO_STATE[event?.type]);
  },
});
