/**
 * The stable launcher at `~/.agentbox/bin/agentbox`.
 *
 * `npm i -g` puts agentbox under the CURRENT Node's prefix. With nvm/fnm/volta/
 * asdf, a project pinning another Node swaps PATH to that version's bin dir and
 * `agentbox` is gone. The launcher pins the Node and the install that ran it by
 * absolute path, so it works whatever `node` PATH resolves to. `~/.agentbox/bin`
 * is APPENDED to PATH once, via one line in the shell rc: the agentbox of the
 * active Node wins when it has one (and its run re-points the launcher), and the
 * launcher is the fallback when it doesn't. Appending is also the only order
 * that holds on every OS (macOS path_helper and nvm reorder anything prepended).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectExecutionMethod } from '../exec-method.js';
import { AGENTBOX_VERSION } from '../version.js';
import { isNewer } from './semver-lite.js';

const MARKER = '# agentbox launcher';

export function launcherDir(home: string = homedir()): string {
  return join(home, '.agentbox', 'bin');
}

export function launcherPath(home: string = homedir()): string {
  return join(launcherDir(home), 'agentbox');
}

/** POSIX single-quote a string for sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launcher script. Fallbacks, in order:
 * - the recorded install has the pre-launcher layout (an older version was
 *   installed over it, whose bin is `dist/index.js`) → run that;
 * - the recorded Node is gone (its nvm version was uninstalled) → `node` on PATH;
 * - the install itself is gone → another `agentbox` on PATH that isn't a
 *   launcher, at most one hop (`AGENTBOX_LAUNCHER_HOP`);
 * - else a reinstall hint. The next run from a global install re-points it.
 */
export function renderLauncher(node: string, script: string, version?: string): string {
  return `#!/bin/sh
${MARKER} (written by agentbox; rewritten on install and self-update)
${version ? `# version: ${version}\n` : ''}node=${shq(node)}
script=${shq(script)}
if [ ! -f "$script" ]; then
  legacy="\${script%/bin/agentbox.js}/dist/index.js"
  [ -f "$legacy" ] && script=$legacy
fi
if [ -f "$script" ]; then
  if [ -x "$node" ]; then
    exec "$node" "$script" "$@"
  fi
  echo "agentbox: $node no longer exists; using node from PATH. Run 'agentbox install' to re-point ~/.agentbox/bin/agentbox." >&2
  exec node "$script" "$@"
fi
if [ -n "$AGENTBOX_LAUNCHER_HOP" ]; then
  echo "agentbox: $script no longer exists, and the agentbox it fell back to is a launcher too. Reinstall: npm install -g @madarco/agentbox" >&2
  exit 127
fi
self_dir=$(cd "$(dirname "$0")" && pwd -P)
IFS=:
for d in $PATH; do
  d_real=$(cd "$d" 2>/dev/null && pwd -P) || continue
  [ "$d_real" = "$self_dir" ] && continue
  grep -q '^${MARKER}' "$d/agentbox" 2>/dev/null && continue
  if [ -x "$d/agentbox" ]; then
    unset IFS
    AGENTBOX_LAUNCHER_HOP=1
    export AGENTBOX_LAUNCHER_HOP
    echo "agentbox: $script no longer exists; using $d/agentbox. Run 'agentbox install' to re-point ~/.agentbox/bin/agentbox." >&2
    exec "$d/agentbox" "$@"
  fi
done
echo "agentbox: $script no longer exists (was its Node version uninstalled?). Reinstall: npm install -g @madarco/agentbox" >&2
exit 127
`;
}

export interface LauncherTarget {
  node: string;
  script: string;
  /** The install's version; a launcher pointing at a newer live install is kept. */
  version?: string;
}

/**
 * Where the launcher should point for THIS process, or null when it isn't an
 * npm global install (a source checkout, npx, a project-local dep, pnpm whose
 * global dir doesn't depend on the Node version).
 */
export function launcherTarget(
  input: {
    argv1?: string | undefined;
    execPath?: string;
    /** The bundle's own dir (dist/); `bin/agentbox.js` is its sibling. */
    distDir?: string;
  } = {},
): LauncherTarget | null {
  const argv1 = input.argv1 ?? process.argv[1];
  if (detectExecutionMethod({ argv1 }) !== 'npm') return null;
  const distDir = input.distDir ?? dirname(fileURLToPath(import.meta.url));
  const script = resolve(distDir, '..', 'bin', 'agentbox.js');
  const execPath = input.execPath ?? process.execPath;
  // Volta already pins each global package to its own Node, independent of the
  // project's; a second pin on top would fight its shims.
  if (isVolta(script) || isVolta(execPath)) return null;
  if (!existsSync(script)) return null;
  return { node: stableNode(execPath, script), script, version: AGENTBOX_VERSION };
}

/**
 * Prefer `<prefix>/bin/node` next to the install over `process.execPath` when
 * both are the same binary: Homebrew's execPath is a versioned Cellar path that
 * `brew upgrade` deletes, while `/opt/homebrew/bin/node` survives it.
 */
function isVolta(p: string): boolean {
  return p.includes('/.volta/');
}

export function stableNode(execPath: string, script: string): string {
  const candidates: string[] = [];
  const i = script.lastIndexOf('/lib/node_modules/');
  if (i >= 0) candidates.push(join(script.slice(0, i), 'bin', 'node'));
  // Keg-only formulae (node@22) never link into <prefix>/bin, but
  // <prefix>/opt/<formula> survives upgrades the way the Cellar path doesn't.
  const cellar = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (cellar) candidates.push(join(cellar[1]!, 'opt', cellar[2]!, 'bin', 'node'));
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const c of candidates) {
    try {
      if (c !== execPath && realpathSync(c) === real) return c;
    } catch {
      // Not there (custom npm prefix, not Homebrew) — try the next.
    }
  }
  return execPath;
}

/**
 * The argv prefix that runs agentbox, for things persisted outside this process
 * (the hub autostart unit, the herdr shim): the launcher when this is a global
 * install that has one, so they survive a Node switch and keep the version
 * check; otherwise this Node + this entry, as before.
 */
export function cliInvocation(
  target: LauncherTarget | null = launcherTarget(),
  home: string = homedir(),
): string[] {
  if (target && existsSync(launcherPath(home))) return [launcherPath(home)];
  return [process.execPath, process.argv[1] ?? 'agentbox'];
}

/**
 * Write the launcher when its content would change. Returns whether it wrote.
 * Atomic (temp + rename) so a concurrent run never execs a half-written file.
 */
export function ensureLauncher(
  target: LauncherTarget | null = launcherTarget(),
  home: string = homedir(),
): boolean {
  if (!target) return false;
  const path = launcherPath(home);
  const body = renderLauncher(target.node, target.script, target.version);
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Missing — write it.
  }
  if (current === body) return false;
  if (current !== undefined && keepCurrent(current, target)) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, body, { mode: 0o755 });
  renameSync(tmp, path);
  return true;
}

/**
 * Don't re-point at an older build: a stale copy under another Node (run because
 * that Node's bin dir comes first in some project) must not take the launcher
 * from a newer install that still exists.
 */
function keepCurrent(current: string, target: LauncherTarget): boolean {
  const field = (re: RegExp): string | undefined => re.exec(current)?.[1];
  const node = field(/^node='(.*)'$/m)?.replace(/'\\''/g, "'");
  const script = field(/^script='(.*)'$/m)?.replace(/'\\''/g, "'");
  const version = field(/^# version: (\S+)$/m);
  if (!node || !script || !version || !target.version) return false;
  if (script === target.script) return false;
  if (!existsSync(node) || !existsSync(script)) return false;
  return isNewer(version, target.version);
}

/**
 * Older builds cached a downloaded `cloudflared` in `~/.agentbox/bin`, the dir
 * that now goes on PATH. Move it to `~/.agentbox/cache/bin` so it is neither
 * exposed on PATH nor found first by the tunnel's own PATH lookup.
 */
export function moveLegacyCloudflared(home: string = homedir()): void {
  const old = join(launcherDir(home), 'cloudflared');
  if (!existsSync(old)) return;
  const dest = join(home, '.agentbox', 'cache', 'bin', 'cloudflared');
  try {
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) rmSync(old, { force: true });
    else renameSync(old, dest);
  } catch {
    // Best effort: a leftover copy only costs a stale binary on PATH.
  }
}

/** Startup hook: never throws, never prints. */
export function ensureLauncherQuietly(): void {
  try {
    if (ensureLauncher()) moveLegacyCloudflared();
  } catch {
    // Read-only home, odd FS — the launcher is a convenience, not a requirement.
  }
}

/**
 * `process.env` with the running Node's bin dir first on PATH. For spawning
 * `npm` (whose shebang is `env node`, and whose global prefix follows the Node
 * that runs it): under the launcher, PATH's node may be another version, and
 * `npm i -g` would then update an install the launcher doesn't point at.
 */
export function envWithRunningNode(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Under Volta, its npm shim on PATH is what installs into the right place.
  if (isVolta(process.execPath)) return env;
  const bin = dirname(process.execPath);
  const path = env['PATH'] ?? '';
  const parts = path.split(delimiter).filter((p) => p !== bin);
  return { ...env, PATH: [bin, ...parts].join(delimiter) };
}

/**
 * The env to spawn `cmd` with: the running Node first on PATH for `npm` only.
 * For anything else (pnpm, `agentbox`) PATH stays as is, or a stale npm
 * `agentbox` or a corepack `pnpm` shim in this Node's bin dir would win.
 */
export function spawnEnvFor(cmd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return basename(cmd) === 'npm' ? envWithRunningNode(env) : env;
}

// ---------- shell rc ----------

export type ShellKind = 'zsh' | 'bash' | 'fish';

export interface ShellRc {
  shell: ShellKind;
  /** Absolute path of the rc file. */
  file: string;
  /** The exact line (with its marker comment). */
  line: string;
}

const RC_MARKER = '# added by agentbox';
const POSIX_LINE = `export PATH="$PATH:$HOME/.agentbox/bin" ${RC_MARKER}`;

/**
 * Which `.zshenv` zsh actually reads. zsh reads `$ZDOTDIR/.zshenv` only when
 * ZDOTDIR is set before zsh starts; the common setup sets it INSIDE
 * `~/.zshenv`, and then `$ZDOTDIR/.zshenv` is never read. So `~/.zshenv`,
 * unless ZDOTDIR points inside HOME and `~/.zshenv` doesn't set it itself.
 * A ZDOTDIR outside HOME (a scratch HOME inheriting the real one) is ignored.
 */
export function zshenvFile(home: string, zdotdir: string | undefined): string {
  const homeFile = join(home, '.zshenv');
  if (!zdotdir || zdotdir === home || !zdotdir.startsWith(home + '/')) return homeFile;
  let body: string | undefined;
  try {
    body = readFileSync(homeFile, 'utf8');
  } catch {
    // No ~/.zshenv — ZDOTDIR comes from the environment.
  }
  if (body !== undefined && /\bZDOTDIR=/.test(body)) return homeFile;
  return join(zdotdir, '.zshenv');
}

/**
 * The rc file and line for the user's login shell, or null for a shell we don't
 * edit. zsh uses `.zshenv`: it is read by every zsh, including the
 * non-interactive `zsh -lc 'agentbox …'` the menu-bar app and the hub's
 * integrations spawn — `.zshrc` is read by interactive shells only.
 */
export function shellRcFor(
  shellPath: string | undefined = process.env['SHELL'],
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellRc | null {
  const name = basename(shellPath ?? '');
  if (name === 'zsh') {
    return { shell: 'zsh', file: zshenvFile(home, env['ZDOTDIR']), line: POSIX_LINE };
  }
  if (name === 'bash') {
    // macOS Terminal opens login shells, Linux terminals interactive non-login
    // ones (~/.bashrc). A login bash reads only the FIRST of these that exists,
    // so creating ~/.bash_profile would stop an existing ~/.profile loading.
    const login = ['.bash_profile', '.bash_login', '.profile'].find((f) =>
      existsSync(join(home, f)),
    );
    return {
      shell: 'bash',
      file: join(home, platform === 'darwin' ? (login ?? '.bash_profile') : '.bashrc'),
      line: POSIX_LINE,
    };
  }
  if (name === 'fish') {
    return {
      shell: 'fish',
      file: join(home, '.config', 'fish', 'config.fish'),
      line: `fish_add_path --global --append --path $HOME/.agentbox/bin ${RC_MARKER}`,
    };
  }
  return null;
}

/** Whether the rc file already carries the line (by marker or by path). */
export function rcHasLine(rc: ShellRc): boolean {
  try {
    const body = readFileSync(rc.file, 'utf8');
    return body.includes(RC_MARKER) || body.includes('.agentbox/bin');
  } catch {
    return false;
  }
}

/** Append the line once. Returns false when it was already there. */
export function addRcLine(rc: ShellRc): boolean {
  if (rcHasLine(rc)) return false;
  let prefix = '';
  try {
    const body = readFileSync(rc.file, 'utf8');
    if (body.length > 0 && !body.endsWith('\n')) prefix = '\n';
  } catch {
    mkdirSync(dirname(rc.file), { recursive: true });
  }
  writeFileSync(rc.file, `${prefix}${rc.line}\n`, { flag: 'a' });
  return true;
}

/** Whether `~/.agentbox/bin` is on this process's PATH already. */
export function launcherDirOnPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  const dir = launcherDir(home);
  return (env['PATH'] ?? '').split(delimiter).some((p) => p === dir || p === `${dir}/`);
}
