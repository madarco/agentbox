// Promote-only tmux-pane safety net for Claude's activity state. Claude's
// hooks (claude-managed-settings.json) are the PRIMARY signal; this only
// backstops the one failure that strands an orchestrator: a prompt the hooks
// missed (MCP tool dialogs have no hook; the Notification:permission_prompt
// hook can fire late or drop), leaving state stuck on `working` so
// `agent wait-for input-needed` never wakes.
//
// Unlike the codex scraper (which is codex's only state source), this scraper
// is deliberately one-way: when the pane shows a prompt it calls
// `reporter.markScreenWaiting()`, which promotes `working`→`waiting` ONLY and
// never touches the richer hook-driven states. A real hook overwrites
// `waiting`→`working` when the agent resumes, so there's no demote path.
//
// Cheap: one `tmux capture-pane -p` per tick, and `markScreenWaiting()` is a
// no-op once promoted, so a held-up prompt doesn't churn the relay.

import { spawn } from 'node:child_process';
import type { StatusReporter } from './status-reporter.js';

const DEFAULT_INTERVAL_MS = 1_500;
const DEFAULT_SESSION = 'claude';
// The active prompt lives at the bottom of the pane; match only there so
// answered prompts scrolled up into history don't re-trigger.
const BOTTOM_LINES = 25;

// A still-generating turn shows an interrupt hint in the footer. If it's
// present we are working, not waiting — never promote (guards against a
// just-rendered or just-answered prompt still in the bottom region while
// Claude streams below it).
const WORKING_GUARD = /\besc to interrupt\b|ctrl-?c to (stop|interrupt)/i;

// Bottom-anchored signals that Claude is parked on an interactive prompt.
// Over-match toward waiting (promote-only makes a false positive self-correct
// within a tick when the next hook re-asserts working), but keep each pattern
// specific to the select-prompt framing to avoid matching prose.
const WAITING_PATTERNS: readonly RegExp[] = [
  /❯\s*\d+\.\s/, // the selector arrow on a numbered option — the Claude select menu
  /Do you want to proceed\?/i,
  /Would you like to proceed\?/i,
  /\b\d+\.\s+Yes\b/, // a "N. Yes" option line
  /\b(wants to (use|run|access)|Allow .* to (use|run|access))/i, // MCP / tool trust dialog
];

export interface ClaudeScraperOptions {
  reporter: StatusReporter;
  sessionName?: string;
  intervalMs?: number;
  /** Override the tmux runner — used by unit tests to feed fake pane output. */
  capturePane?: (sessionName: string) => Promise<string | null>;
}

export interface ClaudeScraperHandle {
  stop(): void;
}

/**
 * Start the Claude tmux-pane safety net. Returns a handle so the daemon can
 * stop it on shutdown. No-ops when no claude session is present.
 */
export function startClaudeScraper(opts: ClaudeScraperOptions): ClaudeScraperHandle {
  const sessionName = opts.sessionName ?? DEFAULT_SESSION;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const capture = opts.capturePane ?? defaultCapturePane;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const pane = await capture(sessionName);
      if (pane === null) return; // no claude session — nothing to backstop
      if (matchWaiting(pane)) opts.reporter.markScreenWaiting();
    } catch {
      // Pane capture failures (tmux not ready, transient errors) are non-fatal.
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Pure detector — exported for unit testing without spawning tmux. True when
 * the bottom region of the pane looks like an active prompt and the agent is
 * not visibly mid-generation.
 */
export function matchWaiting(pane: string): boolean {
  const region = pane.split('\n').slice(-BOTTOM_LINES).join('\n');
  if (WORKING_GUARD.test(region)) return false;
  return WAITING_PATTERNS.some((re) => re.test(region));
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
