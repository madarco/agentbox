import type { Command } from 'commander';

export interface WatchableOptions {
  watch?: boolean;
  interval?: string;
}

/** Add the shared `-w/--watch` + `--interval` options to a command. */
export function withWatchOptions(cmd: Command): Command {
  return cmd
    .option('-w, --watch', 'redraw continuously until interrupted (Ctrl-C)')
    .option('--interval <seconds>', 'refresh interval for --watch', '2');
}

function parseIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 2000;
  // Floor at 250ms so a typo like `--interval 0.001` can't busy-spin.
  return Math.max(250, Math.round(n * 1000));
}

/** What an {@link WatchOptions.onKey} handler decides for a keypress. */
export type WatchKeyAction = 'redraw' | 'exit' | 'ignore';

export interface WatchOptions {
  /**
   * Handle a single keypress while watching. `'redraw'` repaints immediately
   * (e.g. a scope toggle), `'exit'` ends the watch, `'ignore'` does nothing.
   * Providing this enables raw-mode key capture (only when stdin is a TTY);
   * without it the watch keeps its plain Ctrl-C-only behavior.
   */
  onKey?: (key: string) => WatchKeyAction;
  /**
   * Drop the `watching every Xs — … — exit` chrome line, leaving `produce()`'s
   * output as the entire screen. For narrow surfaces (the cmux dock sidebar)
   * where the chrome just wraps into noise.
   */
  hideStatusLine?: boolean;
}

/**
 * Redraw `produce()`'s output on a fixed interval until the user hits Ctrl-C.
 * Clears the screen (and scrollback) each tick so the view stays put. A
 * `produce()` failure is shown inline and retried next tick — boxes routinely
 * disappear briefly during stop/start, and the persisted status is still
 * readable while paused, so a transient error shouldn't end the watch.
 *
 * With `opts.onKey` and a TTY stdin, the view also captures keystrokes in raw
 * mode (e.g. an in-panel scope toggle). Raw mode suppresses the default Ctrl-C
 * SIGINT, so `\x03` and `q` are handled explicitly as exit.
 */
export async function watchRender(
  produce: () => Promise<string>,
  rawInterval: string | undefined,
  opts: WatchOptions = {},
): Promise<void> {
  const ms = parseIntervalMs(rawInterval);
  const intervalLabel = `${String(ms / 1000)}s`;
  process.stdout.write('\x1b[?25l'); // hide cursor

  const stdin = process.stdin;
  const interactive = typeof opts.onKey === 'function' && stdin.isTTY === true;
  const restore = (): void => {
    if (interactive && stdin.isTTY) stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h'); // restore cursor
  };
  process.once('exit', restore);

  // `wake` lets a keypress break the current sleep so a 'redraw' is immediate.
  let wake: (() => void) | null = null;
  let exiting = false;
  const exit = (): void => {
    exiting = true;
    wake?.();
  };

  if (interactive) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      for (const key of chunk) {
        if (key === '\x03' || key === 'q') {
          exit();
          return;
        }
        const action = opts.onKey?.(key) ?? 'ignore';
        if (action === 'exit') {
          exit();
          return;
        }
        if (action === 'redraw') wake?.();
      }
    });
  } else {
    process.once('SIGINT', () => process.exit(0));
  }

  const hint = interactive ? 'q or Ctrl-C to exit' : 'Ctrl-C to exit';
  const sleep = (d: number): Promise<void> =>
    new Promise((r) => {
      const t = setTimeout(() => {
        wake = null;
        r();
      }, d);
      wake = (): void => {
        clearTimeout(t);
        wake = null;
        r();
      };
    });

  for (;;) {
    let body: string;
    try {
      body = await produce();
    } catch (err) {
      body = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const ts = new Date().toLocaleTimeString();
    const trimmed = body.replace(/\n+$/, '');
    if (opts.hideStatusLine) {
      // In-place redraw: home, clear each line to EOL, then clear to end of
      // screen. Avoids the full-screen 2J blank-flash so a narrow dock panel
      // refreshes — and re-launches on a cmux workspace switch — without the
      // jarring flicker a clear-then-paint produces.
      process.stdout.write(
        '\x1b[H' + trimmed.split('\n').map((l) => l + '\x1b[K').join('\n') + '\x1b[J',
      );
    } else {
      // 2J clear, 3J drop scrollback, H cursor home.
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      process.stdout.write(`watching every ${intervalLabel} — ${ts} — ${hint}\n\n${trimmed}\n`);
    }
    await sleep(ms);
    if (exiting) {
      restore();
      process.exit(0);
    }
  }
}
