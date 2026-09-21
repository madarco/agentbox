import { appendFileSync } from 'node:fs';
import { execa } from 'execa';
import { AGENTBOX_BIN, e2eEnv } from './env.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  /** Resolve with the non-zero result instead of throwing. */
  allowFail?: boolean;
  /** Where the command and its output are appended. */
  log?: string;
}

export class CommandError extends Error {
  constructor(
    readonly cmd: string,
    readonly result: RunResult,
  ) {
    const tail = (result.stderr || result.stdout).trim().split('\n').slice(-15).join('\n');
    super(`\`${cmd}\` exited ${String(result.exitCode)}\n${tail}`);
  }
}

// Strip spinners/cursor codes so logs and assertions read the text a user sees.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const shown = [cmd, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ');
  const started = Date.now();
  if (opts.log) appendFileSync(opts.log, `\n$ ${shown}${opts.cwd ? `   (cwd ${opts.cwd})` : ''}\n`);
  const child = await execa(cmd, args, {
    cwd: opts.cwd,
    env: e2eEnv(opts.env),
    extendEnv: false,
    timeout: opts.timeoutMs ?? 10 * 60_000,
    reject: false,
    input: opts.input,
    stdin: opts.input === undefined ? 'ignore' : 'pipe',
    all: false,
  });
  const result: RunResult = {
    stdout: stripAnsi(String(child.stdout ?? '')),
    stderr: stripAnsi(String(child.stderr ?? '')),
    exitCode: child.timedOut ? 124 : (child.exitCode ?? 1),
    durationMs: Date.now() - started,
  };
  if (opts.log) {
    const body = [result.stdout, result.stderr].filter(Boolean).join('\n--- stderr ---\n');
    appendFileSync(
      opts.log,
      `${body}${body.endsWith('\n') || !body ? '' : '\n'}[exit ${String(result.exitCode)}${child.timedOut ? ' TIMEOUT' : ''} in ${String(Math.round(result.durationMs / 1000))}s]\n`,
    );
  }
  if (result.exitCode !== 0 && !opts.allowFail) throw new CommandError(shown, result);
  return result;
}

/** Run the e2e-installed `agentbox`. */
export function ab(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(AGENTBOX_BIN, args, opts);
}

/** Run `agentbox … --json`-style commands and parse stdout. */
export async function abJson<T>(args: string[], opts: RunOptions = {}): Promise<T> {
  const r = await ab(args, opts);
  return parseJsonOutput<T>(r.stdout);
}

export function parseJsonOutput<T>(stdout: string): T {
  const text = stdout.trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some commands print a line of progress before the JSON; take the last JSON value.
    const start = Math.max(text.lastIndexOf('\n{'), text.lastIndexOf('\n['));
    if (start >= 0) return JSON.parse(text.slice(start + 1)) as T;
    throw new Error(`expected JSON output, got: ${text.slice(0, 300)}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Thrown from a poll callback to stop polling at once. */
export class FatalPollError extends Error {}

/** Poll `fn` until it returns a truthy value or the deadline passes. */
export async function poll<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      if (err instanceof FatalPollError) throw err;
      lastErr = err;
    }
    await sleep(opts.intervalMs ?? 3000);
  }
  const why =
    lastErr instanceof Error ? ` (last error: ${lastErr.message.split('\n')[0] ?? ''})` : '';
  throw new Error(
    `timed out after ${String(Math.round(opts.timeoutMs / 1000))}s waiting for ${what}${why}`,
  );
}
