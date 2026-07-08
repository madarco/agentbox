/**
 * Shared helpers for `agentbox open --in <app>`: which host apps a box can be
 * opened in, and whether each is installed on this machine.
 *
 * Detection is a point-in-time probe (`agentbox open --targets [--json]`) that
 * the tray app runs once at launch — it must stay cheap (fs checks only, no
 * spawns) and never throw on a platform where an app can't exist (Linux has no
 * /Applications). Everything is seam-injected so the matrix is unit-testable.
 */

import { existsSync as realExistsSync } from 'node:fs';
import { homedir as realHomedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type OpenInApp = 'codex' | 'herdr' | 'cmux' | 'vscode' | 'iterm2';
export type OpenTarget = OpenInApp | 'finder';

export const OPEN_IN_APPS: readonly OpenInApp[] = ['codex', 'herdr', 'cmux', 'vscode', 'iterm2'];

/**
 * Providers whose per-box SSH identity outlives the CLI call (see
 * packages/sandbox-core/src/cloud-ssh.ts). Codex connects on its own later, so
 * an expiring token credential (Daytona) or no SSH at all (docker/vercel/e2b)
 * disqualifies the box.
 */
export const PERSISTENT_SSH_PROVIDERS: readonly string[] = ['hetzner'];

/**
 * Providers `agentbox code` can attach an IDE to: docker via the Dev Containers
 * attached-container URI, clouds via a Remote-SSH alias.
 */
export const IDE_PROVIDERS: readonly string[] = ['docker', 'hetzner', 'daytona'];

export interface DetectSeams {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: () => string;
  existsSync: (path: string) => boolean;
}

function realSeams(): DetectSeams {
  return {
    env: process.env,
    platform: process.platform,
    homedir: realHomedir,
    existsSync: realExistsSync,
  };
}

export interface OpenTargetInfo {
  available: boolean;
  /** Box providers this app can open; omitted = any box. */
  providers?: string[];
}

export type OpenTargetsReport = Record<OpenInApp, OpenTargetInfo>;

/** True when `name` resolves to an executable-looking entry on PATH (fs check
 *  only — no spawn, so a non-executable file false-positives; acceptable for a
 *  menu-availability probe). */
export function pathHasBinary(name: string, seams: DetectSeams): boolean {
  const path = seams.env['PATH'] ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    if (seams.existsSync(join(dir, name))) return true;
  }
  return false;
}

function macAppInstalled(appName: string, seams: DetectSeams): boolean {
  if (seams.platform !== 'darwin') return false;
  return (
    seams.existsSync(join('/Applications', appName)) ||
    seams.existsSync(join(seams.homedir(), 'Applications', appName))
  );
}

/** Herdr's well-known session socket, when the server is (or was) running. */
export function defaultHerdrSocketPath(seams: DetectSeams = realSeams()): string | undefined {
  const p = join(seams.homedir(), '.config', 'herdr', 'herdr.sock');
  return seams.existsSync(p) ? p : undefined;
}

const CMUX_APP_CLI_SUFFIX = 'cmux.app/Contents/Resources/bin/cmux';

/**
 * VS Code-family desktop apps, in try order. Each maps its macOS `.app` bundle
 * to the `--folder-uri`-capable CLI *inside* the bundle. A freshly-dragged
 * install has the bundle but no `code`/`cursor` shim on PATH (that shim only
 * appears after the user runs "Shell Command: Install 'code' command in PATH"),
 * so detection and launch must fall back to the bundle — otherwise the tray's
 * Open In… menu hides VS Code entirely on an otherwise-ready machine.
 */
interface VscodeApp {
  /** IDE flavor (matches `IdeFlavor` in sandbox-docker). */
  flavor: 'vscode' | 'cursor';
  /** PATH binary name, tried before the bundle. */
  cli: string;
  /** macOS bundle name under /Applications or ~/Applications. */
  appName: string;
  /** Path to the bundled CLI, relative to the .app bundle. */
  bundleCliSuffix: string;
}

const VSCODE_APPS: readonly VscodeApp[] = [
  {
    flavor: 'vscode',
    cli: 'code',
    appName: 'Visual Studio Code.app',
    bundleCliSuffix: 'Contents/Resources/app/bin/code',
  },
  {
    flavor: 'cursor',
    cli: 'cursor',
    appName: 'Cursor.app',
    bundleCliSuffix: 'Contents/Resources/app/bin/cursor',
  },
];

/**
 * Resolve a VS Code-family `--folder-uri` CLI: PATH first, then the macOS
 * bundle's bundled `code`/`cursor` binary (so a drag-installed app with no PATH
 * shim still launches, and via the real CLI rather than the `open <scheme>://`
 * protocol handler whose %2B URL-encoding can break the Remote attach). `cli`
 * is a flavor CLI name (`code` / `cursor`); returns undefined when neither the
 * CLI nor its bundle is present.
 */
export function resolveVscodeCli(cli: string, seams: DetectSeams = realSeams()): string | undefined {
  if (pathHasBinary(cli, seams)) return cli;
  if (seams.platform !== 'darwin') return undefined;
  const app = VSCODE_APPS.find((a) => a.cli === cli);
  if (!app) return undefined;
  for (const root of ['/Applications', join(seams.homedir(), 'Applications')]) {
    const p = join(root, app.appName, app.bundleCliSuffix);
    if (seams.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Locate a cmux control CLI usable from *outside* cmux: explicit env override,
 * then PATH, then the macOS app bundle (cmux does not install itself on PATH;
 * `/Applications` and `~/Applications` both count, matching detectOpenTargets).
 * Distinct from `cmuxBinary()` in terminal/host.ts, which assumes it runs
 * inside cmux where `CMUX_BUNDLED_CLI_PATH` is always set.
 */
export function resolveCmuxBinary(seams: DetectSeams = realSeams()): string | undefined {
  const bundled = seams.env['CMUX_BUNDLED_CLI_PATH'];
  if (bundled && bundled.length > 0) return bundled;
  if (pathHasBinary('cmux', seams)) return 'cmux';
  if (seams.platform === 'darwin') {
    for (const root of ['/Applications', join(seams.homedir(), 'Applications')]) {
      const cli = join(root, CMUX_APP_CLI_SUFFIX);
      if (seams.existsSync(cli)) return cli;
    }
  }
  return undefined;
}

/** Probe which `--in` targets are installed on this host. */
export function detectOpenTargets(seams: DetectSeams = realSeams()): OpenTargetsReport {
  return {
    codex: {
      available: macAppInstalled('Codex.app', seams),
      providers: [...PERSISTENT_SSH_PROVIDERS],
    },
    herdr: {
      available: pathHasBinary('herdr', seams) || defaultHerdrSocketPath(seams) !== undefined,
    },
    cmux: {
      available: pathHasBinary('cmux', seams) || macAppInstalled('cmux.app', seams),
    },
    vscode: {
      // PATH shim OR the .app bundle — a freshly-dragged VS Code/Cursor has no
      // `code`/`cursor` on PATH until the user runs the "Install 'code' command"
      // step, but `agentbox open --in vscode` can launch it from the bundle.
      available: VSCODE_APPS.some(
        (a) => pathHasBinary(a.cli, seams) || macAppInstalled(a.appName, seams),
      ),
      providers: [...IDE_PROVIDERS],
    },
    iterm2: {
      available: macAppInstalled('iTerm.app', seams),
    },
  };
}

/** The Codex "add SSH connection" deep link (Codex.app registers `codex://`). */
export function codexAddUrl(alias: string): string {
  return `codex://settings/connections/ssh/add?name=${encodeURIComponent(alias)}`;
}

export function renderTargets(report: OpenTargetsReport): string {
  const lines = OPEN_IN_APPS.map((app) => {
    const info = report[app];
    const status = info.available ? 'available' : 'not installed';
    const scope = info.providers ? ` (${info.providers.join(', ')} boxes)` : '';
    return `${app}: ${status}${info.available ? scope : ''}`;
  });
  return lines.join('\n') + '\n';
}
