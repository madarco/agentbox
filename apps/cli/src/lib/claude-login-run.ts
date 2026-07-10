/**
 * Claude's binding of the agent-agnostic login core ({@link runAgentLogin}):
 * drive `claude auth login` in a throwaway docker container under a node-pty,
 * mirror its output verbatim, publish the OAuth URL it prints, feed back the
 * pasted approval code, and on success run the warm-up + host-backup sync.
 *
 * Three callers share this loop with different transports:
 *   - `commands/claude.ts` guided mode (the TTY default) prompts with clack.
 *   - `_claude-login-worker.ts` (`--headless`) uses file-backed state
 *     (`state.json` / `code`).
 *   - the create-job worker (`_run-queued-job.ts`) uses the queue manifest's
 *     `login` sub-state so the hub API/UI can surface it.
 */
import {
  buildClaudeLoginRunArgv,
  SHARED_CLAUDE_VOLUME,
  syncClaudeCredentials,
  volumeClaudeCredentials,
  warmUpClaudeCredentials,
} from '@agentbox/sandbox-docker';
import { runAgentLogin, type AgentLoginPhase } from './agent-login-run.js';
import { CLAUDE_LOGIN_SPEC } from './agent-login-specs.js';
import type { LoginPhase } from './claude-login-session.js';

export interface LoginPhaseUpdate {
  url?: string;
  error?: string;
  lastError?: string;
  warmed?: boolean;
  exitCode?: number;
}

export interface RunClaudeLoginOptions {
  image: string;
  /** Shared claude credential volume the login writes into. */
  volume?: string;
  /** Login-method args forwarded to `claude auth login` (default `['--claudeai']`). */
  extraArgs?: string[];
  /** Verbatim mirror of the container's pty stream (do NOT reformat). */
  writeRaw: (chunk: string) => void;
  /** Optional annotated log line (progress notes, not the raw stream). */
  writeLog?: (line: string) => void;
  /** Publish a phase transition (url on `awaiting-code`, error/warmed on terminal). */
  onPhase: (phase: LoginPhase, update?: LoginPhaseUpdate) => void;
  /** Poll+consume a pasted approval code (return null when none is pending). */
  getCode: () => string | null | undefined;
  /** Abort the login (e.g. on SIGTERM); resolves with an error result. */
  signal?: AbortSignal;
  urlTimeoutMs?: number;
  codeTimeoutMs?: number;
}

export interface RunClaudeLoginResult {
  ok: boolean;
  error?: string;
  warmed?: boolean;
  exitCode?: number;
}

/**
 * The claude spec is `paste-code` only, so the core's `awaiting-approval` phase
 * is unreachable here and `LoginPhase` (which has no such member) stays exact.
 */
function asLoginPhase(phase: AgentLoginPhase): LoginPhase {
  return phase === 'awaiting-approval' ? 'awaiting-code' : phase;
}

/**
 * Run one `claude auth login` to completion. Resolves when the login process
 * exits or a timeout/abort fires; `onPhase` is called for every transition
 * (`starting`→`awaiting-code`→`exchanging`→`done`/`error`) so the caller can
 * mirror state to its own transport.
 */
export async function runClaudeLogin(opts: RunClaudeLoginOptions): Promise<RunClaudeLoginResult> {
  const volume = opts.volume ?? SHARED_CLAUDE_VOLUME;
  const extraArgs =
    opts.extraArgs && opts.extraArgs.length > 0 ? opts.extraArgs : CLAUDE_LOGIN_SPEC.defaultArgs;
  const { image } = opts;

  const { ok, error, warmed, exitCode } = await runAgentLogin({
    spec: CLAUDE_LOGIN_SPEC,
    dockerArgv: buildClaudeLoginRunArgv({ volume, image, extraArgs }),
    writeRaw: opts.writeRaw,
    writeLog: opts.writeLog,
    onPhase: (phase, update) => {
      const { url, error: err, lastError, warmed: w, exitCode: code } = update ?? {};
      opts.onPhase(asLoginPhase(phase), { url, error: err, lastError, warmed: w, exitCode: code });
    },
    getInput: opts.getCode,
    verify: async () => (await volumeClaudeCredentials(volume, image)).hasRefreshToken,
    // Absorb the fresh-token first-request 400 before any box uses these
    // credentials, then mirror them to the host backup.
    finalize: async () => {
      const warm = await warmUpClaudeCredentials(volume, image, {
        onProgress: (l) => opts.writeLog?.(l),
      });
      await syncClaudeCredentials({ volume }, { image, isolate: false });
      return { warmed: warm.warmed };
    },
    signal: opts.signal,
    urlTimeoutMs: opts.urlTimeoutMs,
    inputTimeoutMs: opts.codeTimeoutMs,
  });

  return { ok, error, warmed, exitCode };
}
