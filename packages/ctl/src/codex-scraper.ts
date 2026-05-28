// Tmux-pane scraper for Codex activity state. Codex 0.134.0's JSON-hook firing
// is still unreliable in TUI mode (the `~/.codex/hooks.json` discovery path
// often silently skips even with `--enable hooks --dangerously-bypass-hook-trust`
// — see the comment in `packages/sandbox-docker/scripts/agentbox-codex-hooks.json`).
// Until upstream stabilizes, we approximate activity state by polling the
// rendered codex tmux pane and matching a small ordered pattern table.
//
// Cheap: one `tmux capture-pane -p` per tick (default 1s), only pushes on
// state TRANSITIONS, so the relay's box-status stream only carries real
// changes — no 1Hz heartbeat.

import { spawn } from 'node:child_process';
import type { StatusReporter } from './status-reporter.js';
import type { AgentActivityState } from './types.js';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SESSION = 'codex';

/**
 * Patterns are tried in declared order; first match wins. Designed to
 * over-rather-than-under-match: an extra `working` push on a noisy frame is
 * cheap (the reporter coalesces 300ms anyway), but missing a `waiting` frame
 * is bad — the host won't know codex is blocked on the user.
 */
const PATTERNS: ReadonlyArray<{ re: RegExp; state: AgentActivityState }> = [
  // Permission / approval prompts (highest priority — these mean codex is blocked).
  { re: /Hooks need review|Trust all and continue/i, state: 'waiting' },
  { re: /Do you trust the contents of this directory/i, state: 'waiting' },
  { re: /Allow this command\?|Approve this (command|tool)\?|Press y\/n|\[Y\/n\]/m, state: 'waiting' },
  { re: /Waiting for (your |user )?(response|input|approval|permission)/i, state: 'waiting' },
  // Compaction (codex's `/compact` command and auto-compaction).
  { re: /Compacting (conversation|context)|Summariz(e|ing) (the )?conversation/i, state: 'compacting' },
  // Failure / fatal-error frames.
  { re: /\bError:|\bFailed:|^Traceback /m, state: 'error' },
  // Active work signals — pinned to specific codex TUI fragments to avoid
  // matching every line of english that contains "working" or "running"
  // (e.g. the directory-trust prompt's "Working with untrusted contents"
  // warning is NOT a working state).
  {
    re: /\b(Thinking\.\.\.|Worked for \d|Streaming response|tool call \w|Running command|Generating response|Reasoning\.\.\.|Editing \w)/m,
    state: 'working',
  },
  // Idle: codex shows a status line `gpt-5.5 high · /workspace` (or similar
  // model · cwd footer) at the bottom of the input prompt when ready for
  // input. Lower priority than every "busy" pattern above so an in-flight
  // turn that still shows the footer correctly registers as working.
  { re: /gpt-\d+(\.\d+)?(-\w+)?\s+(low|medium|high|xhigh)\b|OpenAI Codex \(v\d/i, state: 'idle' },
];

export interface CodexScraperOptions {
  reporter: StatusReporter;
  sessionName?: string;
  intervalMs?: number;
  /** Override the tmux runner — used by unit tests to feed fake pane output. */
  capturePane?: (sessionName: string) => Promise<string | null>;
}

export interface CodexScraperHandle {
  stop(): void;
}

/**
 * Start the codex tmux-pane scraper. Returns a handle so the daemon can stop
 * it on shutdown. Idempotent w.r.t. state: a re-asserted state push is a
 * no-op at the reporter level (debounced and coalesced), so the scraper
 * doesn't need to track its own last-pushed state.
 */
export function startCodexScraper(opts: CodexScraperOptions): CodexScraperHandle {
  const sessionName = opts.sessionName ?? DEFAULT_SESSION;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const capture = opts.capturePane ?? defaultCapturePane;
  let lastState: AgentActivityState | null = null;
  let lastSessionPresent = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const pane = await capture(sessionName);
      if (pane === null) {
        // No codex session running. Don't push state — preserve whatever the
        // last known value was so a paused/stopped box keeps its prior state
        // until something concrete supersedes it.
        lastSessionPresent = false;
        return;
      }
      if (!lastSessionPresent) {
        // Session just came up: emit `idle` as a baseline. The pattern below
        // will overwrite it within a tick if codex is mid-work.
        opts.reporter.setCodexState('idle');
        lastState = 'idle';
        lastSessionPresent = true;
      }
      const matched = matchState(pane);
      if (matched !== null && matched !== lastState) {
        opts.reporter.setCodexState(matched);
        lastState = matched;
      }
    } catch {
      // Pane capture failures (tmux not yet ready, transient docker errors)
      // are non-fatal — the next tick retries.
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick(); // immediate first probe

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Pure pattern matcher — exported for unit testing without spawning tmux.
 * Returns null when no pattern matches (caller preserves last-known state).
 */
export function matchState(pane: string): AgentActivityState | null {
  for (const { re, state } of PATTERNS) {
    if (re.test(pane)) return state;
  }
  return null;
}

function defaultCapturePane(sessionName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['capture-pane', '-p', '-t', sessionName], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else resolve(null); // exit 1 = session not present
    });
  });
}
