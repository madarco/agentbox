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
 * Throw unless `os.homedir()` resolves inside the OS temp dir. Both paths go
 * through `realpath`-insensitive `resolve` — on macOS `tmpdir()` is a
 * `/var → /private/var` symlink, so a raw prefix compare gives false negatives.
 */
export function assertTempHome(): string {
  const home = resolve(homedir());
  const tmp = resolve(tmpdir());
  const under = home === tmp || home.startsWith(tmp.endsWith(sep) ? tmp : tmp + sep);
  // Compare the realpath-collapsed forms too (/var vs /private/var on macOS).
  const collapsed = home.replace(/^\/private\//, '/');
  const tmpCollapsed = tmp.replace(/^\/private\//, '/');
  const underCollapsed =
    collapsed === tmpCollapsed ||
    collapsed.startsWith(tmpCollapsed.endsWith(sep) ? tmpCollapsed : tmpCollapsed + sep);
  if (!under && !underCollapsed) {
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
