import type { AgentId } from '@agentbox/core';
// Tmux safety net for Codex's activity state. Codex's hooks
// (`agentbox-codex-hooks.json`) are the primary signal and fire reliably on
// 0.172 (Phase 0, docs/agent-live-status-plan.md); this backstops a hook that
// did not fire, and the startup dialogs no hook can see.
//
// It reads the pane TITLE, not the pane text. Codex prefixes its terminal title
// with a spinner glyph while a turn runs and with `[ ! ] Action Required` while
// it waits on the user, which is exactly the state, with none of the false hits
// of matching prose in the pane (0.172's `Worked for 2s` turn footer read as
// `working` and held every codex box `working` after its turn ended). The pane
// text is still read for the startup dialogs (directory trust, hook review),
// which show before codex sets a title.
//
// Cheap: one tmux title read and one `capture-pane` per tick (default 1s), and it
// pushes only on a change of its OWN derived state, so it never overrides a hook
// with a value it already reported.

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import type { StatusReporter } from './status-reporter.js';
import { sanitizePaneTitle } from './tmux.js';
import type { AgentActivityState } from './types.js';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SESSION = 'codex';

/** Dialogs that block codex on the user, matched in the pane text. */
const PANE_WAITING: readonly RegExp[] = [
  /Hooks need review|Trust all and continue/i,
  /Do you trust the contents of this directory/i,
  /Allow this command\?|Approve this (command|tool)\?|Press y\/n|\[Y\/n\]/m,
];

const TITLE_WAITING = /Action Required/i;
// A leading glyph that is not a letter, a digit or the `[` of `[ ! ]`, then a
// space: codex's spinner frame.
const TITLE_SPINNER = /^[^\p{L}\p{N}[\s]+\s/u;

export interface CodexPaneCapture {
  /** `#{pane_title}`, raw. */
  title: string;
  /** `capture-pane -p` text. */
  pane: string;
}

export interface CodexScraperOptions {
  reporter: StatusReporter;
  /** Which agent this pane belongs to; see {@link ClaudeScraperOptions.agent}. */
  agent?: AgentId;
  sessionName?: string;
  intervalMs?: number;
  /** Override the tmux runner — used by unit tests to feed fake pane output. */
  capture?: (sessionName: string) => Promise<CodexPaneCapture | null>;
}

export interface CodexScraperHandle {
  stop(): void;
}

/**
 * Start the codex tmux safety net. Returns a handle so the daemon can stop it
 * on shutdown.
 */
export function startCodexScraper(opts: CodexScraperOptions): CodexScraperHandle {
  const agent = opts.agent ?? 'codex';
  const sessionName = opts.sessionName ?? DEFAULT_SESSION;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const capture = opts.capture ?? defaultCapture;
  let lastState: AgentActivityState | null = null;
  let lastSessionPresent = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const frame = await capture(sessionName);
      if (frame === null) {
        // No codex session running. Don't push state — preserve whatever the
        // last known value was so a paused/stopped box keeps its prior state
        // until something concrete supersedes it.
        lastSessionPresent = false;
        return;
      }
      if (!lastSessionPresent) {
        // Session just came up: emit `idle` as a baseline.
        opts.reporter.setAgentState(agent, 'idle');
        lastState = 'idle';
        lastSessionPresent = true;
      }
      const matched = matchState(frame.title, frame.pane);
      if (matched !== null && matched !== lastState) {
        opts.reporter.setAgentState(agent, matched);
        lastState = matched;
      }
    } catch {
      // Capture failures (tmux not yet ready, transient errors) are non-fatal —
      // the next tick retries.
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
 * Pure: the state one frame shows. A blocking dialog in the pane wins; then the
 * title prefix (`Action Required` waiting, a spinner working, anything else
 * idle). Null for an empty title, which codex has not set yet: the caller keeps
 * the last known state.
 */
export function matchState(title: string, pane: string): AgentActivityState | null {
  if (PANE_WAITING.some((re) => re.test(pane))) return 'waiting';
  const t = title.trim();
  if (t.length === 0) return null;
  if (TITLE_WAITING.test(t)) return 'waiting';
  if (TITLE_SPINNER.test(t)) return 'working';
  return 'idle';
}

function tmuxOut(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout : null)); // 1 = no session
  });
}

async function defaultCapture(sessionName: string): Promise<CodexPaneCapture | null> {
  const title = await tmuxOut(['display-message', '-p', '-t', sessionName, '#{pane_title}']);
  if (title === null) return null;
  const pane = await tmuxOut(['capture-pane', '-p', '-t', sessionName]);
  if (pane === null) return null;
  // tmux shows the hostname (or the shell) until codex sets a title: that is
  // "no title", which keeps the last state, not a plain title reading idle.
  return { title: sanitizePaneTitle(title, { hostname: hostname(), sessionName }) ?? '', pane };
}
