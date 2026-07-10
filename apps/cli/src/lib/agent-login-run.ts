/**
 * Agent-agnostic core of the guided/headless login flow: drive an agent's
 * `login` command in a throwaway docker container under a node-pty, mirror its
 * output to a sink (never to the user's terminal), publish what it is waiting
 * for, feed back whatever the caller collects, and report the outcome.
 *
 * Everything agent-specific is injected: the docker argv, the prompt detectors
 * ({@link AgentLoginSpec}), and the post-exit `verify`/`finalize` hooks. The IPC
 * is injected too (raw/log/phase/input sinks), so callers reuse the same loop
 * with different transports:
 *   - `commands/claude.ts` guided mode → clack prompts on the host
 *   - `commands/_claude-login-worker.ts` (`--headless`) → file-backed state
 *   - the create-job worker (`_run-queued-job.ts`) → the queue manifest's `login` sub-state
 *
 * PKCE requires the URL-printer and the code-exchanger to be the same process,
 * which is why this holds one live login process for its whole lifetime.
 */
import { loadPtyBackend } from '../pty/pty-backend.js';
import { stripAnsi, type AgentLoginSpec, type LoginNeed } from './agent-login-specs.js';

const URL_TIMEOUT_MS = 60_000;
const INPUT_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 500;
const BUF_CAP = 64 * 1024;

/**
 * `awaiting-code` covers both the paste-code and secret prompts (the caller
 * collects a string either way). `awaiting-approval` is the browser-only device
 * flow, where nothing is typed. The claude specs never emit `awaiting-approval`,
 * so `runClaudeLogin`'s narrower `LoginPhase` contract still holds.
 */
export type AgentLoginPhase =
  | 'starting'
  | 'awaiting-code'
  | 'awaiting-approval'
  | 'exchanging'
  | 'done'
  | 'error';

export interface AgentLoginPhaseUpdate {
  url?: string;
  /** Device-flow code the browser asks for (codex). */
  userCode?: string;
  /** What the container is waiting for; set alongside an `awaiting-*` phase. */
  need?: LoginNeed;
  error?: string;
  lastError?: string;
  warmed?: boolean;
  exitCode?: number;
}

export interface RunAgentLoginOptions {
  spec: AgentLoginSpec;
  /** Full `docker run …` argv for this agent's login (built by the caller). */
  dockerArgv: string[];
  /** Verbatim mirror of the container's pty stream (do NOT reformat, do NOT print). */
  writeRaw: (chunk: string) => void;
  /** Optional annotated log line (progress notes, not the raw stream). */
  writeLog?: (line: string) => void;
  /** Publish a phase transition. */
  onPhase: (phase: AgentLoginPhase, update?: AgentLoginPhaseUpdate) => void;
  /** Poll+consume the input the container is waiting for (null when none yet). */
  getInput: () => string | null | undefined;
  /** True once the login actually wrote credentials (checked after a 0 exit). */
  verify: () => Promise<boolean>;
  /** Post-success work — claude's warm-up + host-backup sync. */
  finalize?: () => Promise<{ warmed?: boolean }>;
  /** Abort the login (e.g. on SIGTERM); resolves with an error result. */
  signal?: AbortSignal;
  urlTimeoutMs?: number;
  /** How long to wait for the user's input (paste-code / secret) or browser approval. */
  inputTimeoutMs?: number;
}

export interface RunAgentLoginResult {
  ok: boolean;
  error?: string;
  warmed?: boolean;
  exitCode?: number;
  /** Set when the container asked something we can't drive from the host. */
  unsupported?: string;
}

/**
 * What to tell the user when the agent rejects their input and re-prompts. The
 * same code path serves both input shapes, so the wording has to follow the
 * need: telling someone whose API key was refused to "paste a fresh code" is
 * nonsense.
 */
export function rejectionMessage(need: LoginNeed | null): string {
  if (need?.kind === 'secret') return `that ${need.label} was not accepted — try another`;
  return 'the code was not accepted — paste a fresh one';
}

/** Last meaningful line(s) of buffered output, stripped of escapes and clamped. */
function tailOf(buf: string): string {
  const lines = stripAnsi(buf)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-2).join(' ');
  return tail.length > 240 ? tail.slice(-240) : tail;
}

/**
 * Run one agent login to completion. Resolves when the login process exits or a
 * timeout/abort fires; `onPhase` is called for every transition so the caller can
 * mirror state to its own transport.
 */
export async function runAgentLogin(opts: RunAgentLoginOptions): Promise<RunAgentLoginResult> {
  const urlTimeoutMs = opts.urlTimeoutMs ?? URL_TIMEOUT_MS;
  const inputTimeoutMs = opts.inputTimeoutMs ?? INPUT_TIMEOUT_MS;
  const writeLog = opts.writeLog ?? ((): void => {});
  const { spec } = opts;

  const backend = await loadPtyBackend();
  if (!backend) {
    const error = 'pty-unavailable: the node-pty prebuild is not installed';
    opts.onPhase('error', { error });
    return { ok: false, error };
  }

  writeLog(`spawning: docker ${opts.dockerArgv.join(' ')}`);

  return await new Promise<RunAgentLoginResult>((resolve) => {
    let buf = '';
    let phase: AgentLoginPhase = 'starting';
    let need: LoginNeed | null = null;
    let lastError: string | undefined;
    let finished = false;
    const disposers: Array<() => void> = [];

    // Never emit a phase after the login has finished (e.g. an abort or timeout
    // that already resolved). Otherwise the post-exit finalize continuation could
    // race in and publish `done` after the caller already treated login as failed.
    const setPhase = (next: AgentLoginPhase, update?: AgentLoginPhaseUpdate): void => {
      if (finished) return;
      phase = next;
      opts.onPhase(next, update);
    };

    const pty = backend.ptySpawn('docker', opts.dockerArgv, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      env: process.env,
    });

    const finish = (result: RunAgentLoginResult): void => {
      if (finished) return;
      finished = true;
      for (const d of disposers) d();
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    if (opts.signal) {
      const onAbort = (): void => {
        if (finished) return;
        const error = 'login aborted';
        writeLog('aborted');
        setPhase('error', { error });
        finish({ ok: false, error });
      };
      if (opts.signal.aborted) onAbort();
      else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
        disposers.push(() => opts.signal?.removeEventListener('abort', onAbort));
      }
    }

    // Poll for the caller's input; only consume one while actually awaiting it.
    const inputPoll = setInterval(() => {
      if (finished || phase !== 'awaiting-code') return;
      const value = opts.getInput();
      if (value) {
        // Never log the value itself — for opencode it is an API key.
        writeLog('received input; submitting to login');
        setPhase('exchanging');
        pty.write(value + '\r');
      }
    }, POLL_MS);
    disposers.push(() => clearInterval(inputPoll));

    pty.onData((d: string) => {
      buf += d;
      if (buf.length > BUF_CAP) buf = buf.slice(-BUF_CAP);
      opts.writeRaw(d);

      if (!need) {
        const found = spec.detect(buf);
        if (!found) return;
        need = found;
        if (found.kind === 'unsupported') {
          writeLog(`unsupported prompt: ${found.reason}`);
          // Nothing has been submitted, so killing here leaves no half-login.
          finish({ ok: false, unsupported: found.reason, error: found.reason });
          return;
        }
        if (found.kind === 'browser-only') {
          writeLog(`published device url: ${found.url}`);
          setPhase('awaiting-approval', { url: found.url, userCode: found.userCode, need: found });
          return;
        }
        const url = found.kind === 'paste-code' ? found.url : undefined;
        if (url) writeLog(`published auth url: ${url}`);
        setPhase('awaiting-code', { url, need: found });
        return;
      }

      if (phase === 'exchanging' && spec.invalidInputPattern?.test(d)) {
        lastError = rejectionMessage(need);
        writeLog('input rejected; back to awaiting-code');
        setPhase('awaiting-code', { lastError, need: need ?? undefined });
      }
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (finished) return;
      writeLog(`login process exited code=${String(exitCode)}`);
      void (async () => {
        let wrote = false;
        try {
          wrote = await opts.verify();
        } catch {
          /* treat as no-creds */
        }
        if (exitCode === 0 && wrote) {
          const { warmed } = (await opts.finalize?.()) ?? {};
          setPhase('done', { warmed });
          finish({ ok: true, warmed, exitCode });
          return;
        }
        const tail = tailOf(buf);
        let error =
          exitCode === 0
            ? 'login exited without writing credentials'
            : `login exited with code ${String(exitCode)}`;
        if (lastError) error = lastError;
        if (tail) error += ` — ${tail}`;
        setPhase('error', { error, exitCode });
        finish({ ok: false, error, exitCode });
      })();
    });

    const urlTimer = setTimeout(() => {
      if (need || finished) return;
      const error = `${spec.agent} login never printed an auth URL (see the log)`;
      writeLog('no auth URL within timeout');
      setPhase('error', { error });
      finish({ ok: false, error });
    }, urlTimeoutMs);
    disposers.push(() => clearTimeout(urlTimer));

    const inputTimer = setTimeout(() => {
      // Only abort while still WAITING — never kill an in-flight exchange (input
      // submitted near the deadline, or a slow token exchange + finalize, must be
      // allowed to finish). `awaiting-approval` polls the browser, so it waits too.
      if (finished || phase === 'exchanging' || phase === 'done' || phase === 'error') return;
      const error = 'timed out waiting for approval (10 min) — run login again';
      writeLog('no input within timeout; aborting');
      setPhase('error', { error });
      finish({ ok: false, error });
    }, inputTimeoutMs);
    disposers.push(() => clearTimeout(inputTimer));
  });
}
