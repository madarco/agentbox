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

/**
 * Redraw `produce()`'s output on a fixed interval until the user hits Ctrl-C.
 * Clears the screen (and scrollback) each tick so the view stays put. A
 * `produce()` failure is shown inline and retried next tick — boxes routinely
 * disappear briefly during stop/start, and the persisted status is still
 * readable while paused, so a transient error shouldn't end the watch.
 */
export async function watchRender(
  produce: () => Promise<string>,
  rawInterval: string | undefined,
): Promise<void> {
  const ms = parseIntervalMs(rawInterval);
  const intervalLabel = `${String(ms / 1000)}s`;
  process.stdout.write('\x1b[?25l'); // hide cursor
  process.once('exit', () => process.stdout.write('\x1b[?25h')); // restore on exit
  process.once('SIGINT', () => process.exit(0));
  const sleep = (d: number): Promise<void> => new Promise((r) => setTimeout(r, d));
  for (;;) {
    let body: string;
    try {
      body = await produce();
    } catch (err) {
      body = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const ts = new Date().toLocaleTimeString();
    // 2J clear, 3J drop scrollback, H cursor home.
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    process.stdout.write(
      `watching every ${intervalLabel} — ${ts} — Ctrl-C to exit\n\n${body.replace(/\n+$/, '')}\n`,
    );
    await sleep(ms);
  }
}
