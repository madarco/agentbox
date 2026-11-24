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
// Seeded from the image-baked copy at /usr/local/share/agentbox/ into
// `$OPENCODE_CONFIG_DIR/plugins/agentbox-state.js` by the `seeds` entry on
// OpenCode's registry row, on every create and agent start. Idempotent
// overwrite. The volume is shared between boxes, so this file can be read by an
// older baked ctl: it uses only the frozen `opencode-state` command and flags
// every ctl has.
//
// State machine (measured on 1.19.6, docs/agent-live-status-plan.md Phase 0):
//   working — the root session's `session.status` is busy or retry. (Not
//             `message.part.delta`: that fires only while the final text
//             streams, so most of a turn, tool calls included, read idle.)
//   waiting — an unanswered `permission.asked`, from any session (a
//             subagent's prompt blocks the user just the same), until its
//             `permission.replied`.
//   idle    — the root session's `session.idle` (or status idle).
//   error   — `session.error`, STICKY until the next busy: an unsupported model
//             fires session.error and then session.idle 2 ms later, which used
//             to overwrite it and hide the failure.
// Sessions with a `parentID` (subagents) are ignored for state: their busy and
// idle flipped the parent to idle mid-turn.
//
// Session id: every report names the root session that last went busy, on
// stdin to `--capture-session`, so ctl appends it to the box's binding log
// (how a session in the shared sqlite db is attributed to this box) and
// publishes it as the box's current session. A TUI `/sessions` switch emits no
// event, so ctl also matches the pane title against this box's sessions.
//
// Only `AgentboxStatePlugin` is exported: opencode calls every export as a
// plugin. The pure tracker rides on it as a property, for the unit tests.

import { spawn } from 'node:child_process';

/** Pure event -> report mapping. `handle` answers the report to send, or null. */
function createTracker() {
  let state = null;
  let sessionId = null;
  let errorSticky = false;
  let sawStatus = false;
  const children = new Set();
  const pending = new Set();
  let last = null;

  const props = (event) =>
    event && event.properties && typeof event.properties === 'object' ? event.properties : {};
  const sidOf = (p) =>
    typeof p.sessionID === 'string'
      ? p.sessionID
      : p.info && typeof p.info.id === 'string'
        ? p.info.id
        : null;
  const isChild = (sid) => sid !== null && children.has(sid);

  function report() {
    if (state === null) return null;
    const key = `${state}\0${sessionId ?? ''}`;
    if (key === last) return null;
    last = key;
    return { state, sessionId };
  }

  function busy(sid) {
    state = 'working';
    errorSticky = false;
    if (sid) sessionId = sid;
  }

  function idle() {
    if (errorSticky) return;
    state = pending.size > 0 ? 'waiting' : 'idle';
  }

  return {
    handle(event) {
      const type = event && event.type;
      const p = props(event);
      const sid = sidOf(p);
      switch (type) {
        case 'session.created':
        case 'session.updated': {
          const info = p.info;
          if (info && typeof info.id === 'string' && typeof info.parentID === 'string') {
            children.add(info.id);
            return null;
          }
          // Baseline at startup: a root session exists and nothing ran yet.
          if (type === 'session.created' && state === null) state = 'idle';
          return report();
        }
        case 'session.status': {
          if (isChild(sid)) return null;
          sawStatus = true;
          const s = p.status && p.status.type;
          if (s === 'busy' || s === 'retry') busy(sid);
          else if (s === 'idle') idle();
          return report();
        }
        case 'session.idle':
          if (isChild(sid)) return null;
          idle();
          return report();
        case 'session.error':
          if (isChild(sid)) return null;
          state = 'error';
          errorSticky = true;
          return report();
        case 'permission.asked':
        case 'permission.updated': {
          pending.add(typeof p.id === 'string' ? p.id : `${sid ?? ''}:${pending.size}`);
          state = 'waiting';
          return report();
        }
        case 'permission.replied': {
          const id = [p.requestID, p.permissionID, p.id].find((v) => typeof v === 'string');
          // An id this tracker never saw (another event shape) answers them all:
          // a stuck `waiting` is worse than one that clears early.
          if (id !== undefined && pending.has(id)) pending.delete(id);
          else pending.clear();
          if (pending.size === 0 && state === 'waiting') state = 'working';
          return report();
        }
        case 'message.part.delta':
          // Only for an opencode without session.status: the older signal.
          if (sawStatus || isChild(sid) || errorSticky) return null;
          busy(sid);
          return report();
        default:
          return null;
      }
    },
  };
}

function pushReport(r) {
  try {
    const args = ['opencode-state', r.state];
    if (r.sessionId) args.push('--capture-session');
    const p = spawn('agentbox-ctl', args, {
      stdio: [r.sessionId ? 'pipe' : 'ignore', 'ignore', 'ignore'],
      detached: true,
    });
    p.on('error', () => {});
    if (r.sessionId) {
      p.stdin.on('error', () => {});
      p.stdin.end(JSON.stringify({ session_id: r.sessionId }));
    }
    p.unref();
  } catch {
    // Fire-and-forget. A missing agentbox-ctl bin (test env, older box image)
    // must not throw out of this handler.
  }
}

export const AgentboxStatePlugin = async () => {
  const tracker = createTracker();
  return {
    event: async ({ event }) => {
      const r = tracker.handle(event);
      if (r) pushReport(r);
    },
  };
};
AgentboxStatePlugin.createTracker = createTracker;
