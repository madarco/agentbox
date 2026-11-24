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
// State machine (measured on 1.6.0, docs/agent-live-status-plan.md Phase 0):
//   working — a turn is in flight (`agent_start`), a tool is running
//             (`tool_execution_start`), a message finalized (`message_end`), or
//             the user answered a prompt (`ui_prompt_end`).
//   waiting — an extension or tool is asking the user (`ui_prompt_start`).
//   idle    — `agent_settled`, Pi's real end of turn, and `session_start` as the
//             baseline. NOT `agent_end`: Pi stays busy past it across retries,
//             compaction and follow-up work.
//   error   — an assistant `message_end` with `stopReason: "error"`. It holds
//             over the `agent_settled` that follows, so the settle cannot hide
//             it, and clears on any sign of new work: Pi retries a failed
//             request inside the same run, and a retry that works must not
//             leave the box in `error`.
//
// Session id: every report carries the current session's id and file on stdin
// to `--capture-session`. ctl appends it to the box's binding log (sessions on
// Pi's shared volume are attributed to a box only through that log) and
// publishes it as the box's current session; `session_start` fires on `/new`
// and `/resume`, so the id follows the switch.

import { spawn } from 'node:child_process';

/** Pure event -> report mapping. `handle` answers the report to send, or null. */
function createPiTracker() {
  let state = null;
  let session = null;
  let errorSticky = false;
  let last = null;

  function report() {
    if (state === null) return null;
    const key = `${state}\0${session ? session.id : ''}`;
    if (key === last) return null;
    last = key;
    return { state, session };
  }

  function work() {
    errorSticky = false;
    state = 'working';
    return report();
  }

  return {
    /** `session` is `{ id, file }` from the event's ctx, when it has one. */
    handle(name, event, sessionInfo) {
      if (sessionInfo) session = sessionInfo;
      switch (name) {
        case 'session_start':
          errorSticky = false;
          state = 'idle';
          return report();
        case 'agent_start':
        case 'tool_execution_start':
        case 'ui_prompt_end':
          return work();
        case 'ui_prompt_start':
          errorSticky = false;
          state = 'waiting';
          return report();
        case 'message_end': {
          const m = event && event.message;
          if (m && m.role === 'assistant' && m.stopReason === 'error') {
            errorSticky = true;
            state = 'error';
            return report();
          }
          // A user or tool-result message ends while the error stands too; only
          // a successful assistant message is new work.
          if (errorSticky && !(m && m.role === 'assistant')) return null;
          return work();
        }
        case 'agent_settled':
          if (errorSticky) return null;
          state = 'idle';
          return report();
        default:
          return null;
      }
    },
  };
}

function sessionOf(ctx) {
  try {
    const sm = ctx && ctx.sessionManager;
    const id = sm && typeof sm.getSessionId === 'function' ? sm.getSessionId() : null;
    const file = sm && typeof sm.getSessionFile === 'function' ? sm.getSessionFile() : null;
    // An ephemeral (--no-session) run has no file and nothing to ship.
    if (typeof id !== 'string' || !id || typeof file !== 'string' || !file) return null;
    return { id, file };
  } catch {
    return null;
  }
}

function runReport(r, done) {
  try {
    const args = ['agent-state', 'pi', r.state];
    if (r.session) args.push('--capture-session');
    const p = spawn('agentbox-ctl', args, {
      stdio: [r.session ? 'pipe' : 'ignore', 'ignore', 'ignore'],
      detached: true,
    });
    p.on('error', done);
    p.on('exit', done);
    if (r.session) {
      p.stdin.on('error', () => {});
      p.stdin.end(JSON.stringify({ session_id: r.session.id, transcript_path: r.session.file }));
    }
    p.unref();
  } catch {
    done();
    // Fire-and-forget. A missing agentbox-ctl bin (test env, older box image)
    // must not throw out of this handler.
  }
}

// Reports go out ONE AT A TIME, each after the previous ctl exits. Each is its
// own process that reads stdin and appends a binding before it reaches the
// daemon, so two spawned together (busy then idle a few ms apart) could land in
// either order and leave the wrong state standing. The chain never blocks an
// event handler, and a ctl that hangs is given up on after 3 s.
let chain = Promise.resolve();

function pushReport(r) {
  chain = chain.then(
    () =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        if (typeof t.unref === 'function') t.unref();
        runReport(r, () => {
          clearTimeout(t);
          resolve();
        });
      }),
  );
}

const EVENTS = [
  'session_start',
  'agent_start',
  'tool_execution_start',
  'message_end',
  'ui_prompt_start',
  'ui_prompt_end',
  'agent_settled',
];

// The pure tracker rides on the extension function as a property, for the unit
// tests; a module export would be one more thing Pi's loader has to ignore.
export default function agentboxStateExtension(pi) {
  const tracker = createPiTracker();
  // Pi AWAITS extension handlers, so every one of these must return
  // immediately. `pushReport` spawns detached + unref'd and never awaits, so a
  // slow or absent ctl can never stall a turn.
  for (const name of EVENTS) {
    pi.on(name, (event, ctx) => {
      const r = tracker.handle(name, event, sessionOf(ctx));
      if (r) pushReport(r);
    });
  }
}
agentboxStateExtension.createTracker = createPiTracker;
