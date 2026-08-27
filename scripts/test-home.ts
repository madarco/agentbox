/**
 * Temp-`$HOME` isolation shared by every suite that writes under `~/.agentbox`.
 *
 * Lives in `scripts/` (not a package) so all four suites — config, sandbox-cloud,
 * cli, hub — import the SAME guard by relative path without inventing a
 * workspace dependency edge between test dirs.
 *
 * Why a guard at all: these suites `rm -rf` `$HOME/.agentbox` between tests. If
 * `$HOME` is not actually relocated, that deletes the developer's real secrets,
 * box registry and hub token. It has happened. `setupFiles` does the relocation,
 * but a setup file that silently fails to load (a missing root workspace config,
 * a package with no `vitest.config.ts`) is invisible — so the destructive call
 * itself refuses to run unless the relocation demonstrably took effect.
 */
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Point `$HOME` at a fresh temp dir. Call from a `setupFiles` module ONLY. */
export function useTempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return home;
}

/**
 * Throw unless `os.homedir()` resolves to a subdirectory INSIDE the OS temp dir.
 *
 * Strictly below, never equal: `HOME=/tmp` is a real configuration (containers,
 * some CI images), and there the home's `.agentbox` is real state. Every caller
 * here `mkdtemp`s a subdirectory, so equality is never something a legitimate
 * setup produces — accepting it would only ever green-light the deletion this
 * guard exists to stop.
 *
 * Both paths go through `resolve` — and the `/private` form is compared too,
 * because on macOS `tmpdir()` is a `/var → /private/var` symlink and a raw
 * prefix compare gives false negatives.
 */
export function assertTempHome(): string {
  const home = resolve(homedir());
  const tmp = resolve(tmpdir());
  const strictlyUnder = (child: string, parent: string): boolean =>
    child !== parent && child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  const collapse = (p: string): string => p.replace(/^\/private\//, '/');
  const under = strictlyUnder(home, tmp) || strictlyUnder(collapse(home), collapse(tmp));
  if (!under) {
    throw new Error(
      `refusing to touch ${home}/.agentbox: $HOME is not an isolated temp dir.\n` +
        `This suite deletes $HOME/.agentbox between tests, so running it against a real ` +
        `home would destroy secrets.env, state.json and the hub token.\n` +
        `Its vitest setupFiles did not run — use \`pnpm test\`, or check that the root ` +
        `vitest.workspace.ts still lists this package and that it has a vitest.config.ts.`,
    );
  }
  return home;
}

/** `rm -rf $HOME/.agentbox`, but only ever inside a verified temp home. */
export async function resetTempAgentboxHome(): Promise<void> {
  const home = assertTempHome();
  await rm(join(home, '.agentbox'), { recursive: true, force: true });
}
