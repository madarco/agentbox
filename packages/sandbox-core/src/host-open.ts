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
