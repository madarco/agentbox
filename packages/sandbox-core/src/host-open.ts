import { spawn } from 'node:child_process';

/**
 * The host command that opens a URL or file path in the OS default handler.
 *
 * macOS ships `open`; Linux uses `xdg-open` (from `xdg-utils`, present on any
 * desktop install). We deliberately return only the binary name and let each
 * call site keep its own spawn semantics (sync/async, stdio, detached) — the
 * single platform decision lives here so adding a host platform is a one-line
 * change. Callers already treat a non-zero exit / ENOENT as "couldn't
 * auto-open" and print the target, so an absent `xdg-open` degrades cleanly.
 */
export function hostOpenCommand(): string {
  return process.platform === 'linux' ? 'xdg-open' : 'open';
}

/**
 * Fire-and-forget open of `target` in the host's default handler. Detached +
 * `unref`ed so the caller's event loop isn't held by a browser process, and
 * never throws: every call site has already printed or logged the target, so a
 * missing `xdg-open` degrades to "nothing popped up" rather than an error.
 *
 * The single copy of the spawn semantics for the several places that want
 * exactly this (hub setup, control-plane deploy, the relay's browser-open, the
 * attach footer); {@link hostOpenCommand} stays the primitive for callers that
 * need the exit code.
 */
export function openOnHost(target: string): void {
  try {
    const child = spawn(hostOpenCommand(), [target], { detached: true, stdio: 'ignore' });
    // A missing `xdg-open` surfaces as an ASYNC 'error' event, not a throw, and
    // an unlistened 'error' on a ChildProcess is re-thrown — which would take
    // down the relay daemon (or the attach wrapper) on a host with no desktop
    // opener. The listener is what makes this function actually never-throw.
    child.on('error', () => {
      /* no opener on this host; the caller has already surfaced the target */
    });
    child.unref();
  } catch {
    /* the caller has already surfaced the target */
  }
}
