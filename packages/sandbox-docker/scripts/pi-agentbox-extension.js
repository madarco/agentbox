// AgentBox state-reporting extension for Pi (pi.dev).
//
// Subscribes to Pi's extension event bus and reports each lifecycle transition
// to `agentbox-ctl agent-state pi <state>`. The ctl daemon publishes the state
// to the host relay's status.json, which is what `agentbox list`,
// `agentbox agent state` and `agent wait-for` consume on the host side.
//
// Seeded from the image-baked copy at
// /usr/local/share/agentbox/pi-agentbox-extension.js into the box's
// `~/.pi/agent/extensions/agentbox-state.js` on every create / start, via the
// `seeds` entry on Pi's registry row. Idempotent overwrite.
//
// WHY .js RATHER THAN .ts. Pi's loader accepts either — `isExtensionFile(name)`
// tests `.ts || .js` — and a plain `.js` needs no TypeScript toolchain to be
// present in the box, which keeps the extension working on a minimal image.
//
// WHY THE GENERIC `agent-state pi` OP. The frozen per-agent `<agent>-state`
// command names exist only for the built-in three, because their config volumes
// are SHARED BETWEEN BOXES: a file seeded by a newer image can be read by a box
// running older baked ctl. Pi has no such history, so it uses the generic op
// that every current ctl ships.
//
// Event coverage (Pi's own bus; mirrors the Claude / Codex / OpenCode state
// machine):
//   working   — a turn is in flight (`agent_start`), a tool is running
//               (`tool_execution_start`), or a message just finalized and the
//               turn has not ended yet (`message_end`).
//   idle      — ready for input: `agent_end`, `agent_settled`, and
//               `session_start` as the baseline when a session opens.
//
// Session history: `session_start` also hands the session's id and file to
// `agentbox-ctl agent-state pi idle --capture-session` on stdin (the hook-JSON
// shape the other agents' hooks use), which appends it to the box's binding
// log. Sessions on Pi's shared docker volume are attributed to a box only
// through that log.
//
// Pi has NO permission prompts by design, so there is no `waiting` state to
// report — unlike the other three, nothing in Pi ever blocks on human approval
// of a tool call.

import { spawn } from 'node:child_process';

// Dedupe: `tool_execution_start` and `message_end` fire many times per turn.
// Only spawn agentbox-ctl when the mapped state actually changes, so a turn
// costs ~2 spawns instead of one per event.
let lastState = null;

function pushState(state) {
  if (!state || state === lastState) return;
  lastState = state;
  try {
    const p = spawn('agentbox-ctl', ['agent-state', 'pi', state], {
      stdio: 'ignore',
      detached: true,
    });
    p.unref();
  } catch {
    // Fire-and-forget. A missing agentbox-ctl bin (test env, older box image)
    // must not throw out of this handler.
  }
}

// One binding per session id per process (a reload re-fires session_start).
const bound = new Set();

function bindSession(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    const id = sm && typeof sm.getSessionId === 'function' ? sm.getSessionId() : null;
    const file = sm && typeof sm.getSessionFile === 'function' ? sm.getSessionFile() : null;
    // An ephemeral (--no-session) run has no file and nothing to ship.
    if (typeof id !== 'string' || !id || typeof file !== 'string' || !file || bound.has(id)) return;
    bound.add(id);
    const p = spawn('agentbox-ctl', ['agent-state', 'pi', 'idle', '--capture-session'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify({ session_id: id, transcript_path: file }));
    p.unref();
  } catch {
    // Fire-and-forget, like pushState.
  }
}

export default function (pi) {
  // Pi AWAITS extension handlers, so every one of these must return
  // immediately. `pushState` spawns detached + unref'd and never awaits, so a
  // slow or absent ctl can never stall a turn.
  pi.on('session_start', (_event, ctx) => {
    pushState('idle');
    bindSession(ctx);
  });
  pi.on('agent_start', () => pushState('working'));
  pi.on('tool_execution_start', () => pushState('working'));
  pi.on('message_end', () => pushState('working'));
  pi.on('agent_end', () => pushState('idle'));
  // Newer Pi stays non-idle across retry/compaction/follow-up work and emits
  // `agent_settled` as the real end-of-turn. Older builds do not have it, so
  // both are mapped and the dedupe collapses the duplicate.
  pi.on('agent_settled', () => pushState('idle'));
}
