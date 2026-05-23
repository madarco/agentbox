/**
 * Build a single shell-safe command string from an argv array. Used everywhere
 * we hand a cloud backend's `exec(handle, cmd, ...)` an argv that originated
 * from CLI input — single-quoting every arg neutralises shell metacharacters.
 */
export function quoteShellArgv(argv: readonly string[]): string {
  return argv.map(quoteShellArg).join(' ');
}

export function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  // Fast-path for safe identifiers, paths, simple options: avoid quotes for
  // readability in logs. Anything else falls through to single-quoting.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Wrap a multi-line shell script body so it runs under `bash -c` regardless
 * of what `/bin/sh` points at in the sandbox. Necessary on Daytona's images
 * where `executeCommand` shells out via `dash`, which rejects bash idioms
 * like `set -o pipefail`. Use this for any script that isn't trivially
 * POSIX-only.
 */
export function bashScript(body: string): string {
  return `bash -c ${quoteShellArg(body)}`;
}
