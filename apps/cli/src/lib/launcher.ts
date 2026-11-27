/**
 * The stable launcher at `~/.agentbox/bin/agentbox`.
 *
 * `npm i -g` puts agentbox under the CURRENT Node's prefix. With nvm/fnm/volta/
 * asdf, a project pinning another Node swaps PATH to that version's bin dir and
 * `agentbox` is gone. The launcher pins the Node and the install that ran it by
 * absolute path, so it works whatever `node` PATH resolves to; `~/.agentbox/bin`
 * goes on PATH once, via one line in the shell rc.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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
 * The launcher script. Fallbacks, in order: the recorded Node is gone (its nvm
 * version was uninstalled) → `node` on PATH with a warning; the install itself
 * is gone (it lived under that Node's prefix) → another `agentbox` on PATH; else
 * a reinstall hint. The next run from a global install re-points the launcher.
 */
export function renderLauncher(node: string, script: string, version?: string): string {
  return `#!/bin/sh
${MARKER} (written by agentbox; rewritten on install and self-update)
${version ? `# version: ${version}\n` : ''}node=${shq(node)}
script=${shq(script)}
if [ -f "$script" ]; then
  if [ -x "$node" ]; then
    exec "$node" "$script" "$@"
  fi
  echo "agentbox: $node no longer exists; using node from PATH. Run 'agentbox install' to re-point ~/.agentbox/bin/agentbox." >&2
  exec node "$script" "$@"
fi
self_dir=$(cd "$(dirname "$0")" && pwd -P)
IFS=:
for d in $PATH; do
  d_real=$(cd "$d" 2>/dev/null && pwd -P) || continue
  [ "$d_real" = "$self_dir" ] && continue
  if [ -x "$d/agentbox" ]; then
    unset IFS
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

function stableNode(execPath: string, script: string): string {
  const i = script.lastIndexOf('/lib/node_modules/');
  if (i < 0) return execPath;
  const candidate = join(script.slice(0, i), 'bin', 'node');
  try {
    if (candidate !== execPath && realpathSync(candidate) === realpathSync(execPath)) {
      return candidate;
    }
  } catch {
    // No node next to the install (custom npm prefix) — use the one running.
  }
  return execPath;
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

/** Startup hook: never throws, never prints. */
export function ensureLauncherQuietly(): void {
  try {
    ensureLauncher();
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

/**
 * The rc file and line for the user's login shell, or null for a shell we don't
 * edit. zsh uses `~/.zshenv`: it is read by every zsh, including the
 * non-interactive `zsh -lc 'agentbox …'` the menu-bar app and the hub's
 * integrations spawn — `~/.zshrc` is read by interactive shells only.
 */
export function shellRcFor(
  shellPath: string | undefined = process.env['SHELL'],
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellRc | null {
  const name = basename(shellPath ?? '');
  if (name === 'zsh') {
    const zdot = env['ZDOTDIR'];
    return {
      shell: 'zsh',
      file: join(zdot && zdot.length > 0 ? zdot : home, '.zshenv'),
      line: `export PATH="$HOME/.agentbox/bin:$PATH" ${RC_MARKER}`,
    };
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
      line: `export PATH="$HOME/.agentbox/bin:$PATH" ${RC_MARKER}`,
    };
  }
  if (name === 'fish') {
    return {
      shell: 'fish',
      file: join(home, '.config', 'fish', 'config.fish'),
      line: `fish_add_path --global --move --path $HOME/.agentbox/bin ${RC_MARKER}`,
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
