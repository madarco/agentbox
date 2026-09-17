/**
 * Keep stdout pure for the machine-readable commands.
 *
 * `@clack/prompts` writes ALL of its chrome to `process.stdout` — `log.*`, the
 * spinner's frames, and (through `@clack/core`'s `block()`) the raw cursor
 * escapes `\x1b[?25l` / `\x1b[?25h`. None of it is redirectable: clack 0.9.1
 * takes no `output` option. So a command whose stdout is a value — `agentbox
 * agent state <box>` piped into `$(…)` — leaks chrome into that value whenever
 * anything on its path decides to talk. The observed case: `resolveBoxPromptSource`
 * auto-starts a local hub behind a spinner, so right after a `hub restart` the
 * captured "state" was `\x1b[?25h` followed by `working`.
 *
 * The fix is a boundary, not a per-call-site audit: swap `process.stdout.write`
 * for the duration of the action so EVERYTHING lands on stderr, and hand the
 * action an `emit` bound to the real stdout for the one or two lines that are
 * actually data. A human loses nothing — stderr is still the terminal.
 *
 * Restored in a `finally` only. Deliberately NOT from a `process.on('exit')`
 * hook: clack's spinner installs its own `exit` listener inside `s.start()`,
 * i.e. after ours, so restoring there would hand real stdout back just in time
 * for clack's abort message to land on it.
 */

type WriteFn = typeof process.stdout.write;
type WriteCb = (err?: Error | null) => void;

export interface MachineOutput {
  /** Write a line to the REAL stdout. This is the command's value. */
  emit(chunk: string): void;
}

function divertToStderr(chunk: unknown, a?: unknown, b?: unknown): boolean {
  const cb = (typeof a === 'function' ? a : typeof b === 'function' ? b : undefined) as
    | WriteCb
    | undefined;
  if (typeof a === 'string') {
    return process.stderr.write(chunk as string, a as BufferEncoding, cb);
  }
  return process.stderr.write(chunk as string | Uint8Array, cb);
}

/**
 * Run `fn` with stdout diverted to stderr; only what `fn` passes to `emit`
 * reaches the real stdout.
 */
export async function withCleanStdout<T>(fn: (out: MachineOutput) => Promise<T>): Promise<T> {
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = divertToStderr as WriteFn;
  try {
    return await fn({
      emit: (chunk: string) => {
        real(chunk);
      },
    });
  } finally {
    process.stdout.write = real;
  }
}
