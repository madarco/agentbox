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

// `finder` is a first-class open target: `agentbox open <box>` (no `--in`) is
// equivalent to `--in finder` and sshfs-mounts /workspace + reveals it. It's an
// app like the others so the Hub/Tray "Open In" surfaces can list it, gated to
// SSH-capable providers via its `providers` in detectOpenTargets.
export type OpenInApp = 'codex' | 'herdr' | 'cmux' | 'vscode' | 'iterm2' | 'finder';
export type OpenTarget = OpenInApp;

export const OPEN_IN_APPS: readonly OpenInApp[] = [
  'codex',
  'herdr',
  'cmux',
  'vscode',
  'iterm2',
  'finder',
];

/**
 * Providers whose per-box SSH identity outlives the CLI call (see
 * packages/sandbox-core/src/cloud-ssh.ts). Codex connects on its own later, so
 * an expiring token credential (Daytona) or no SSH at all (vercel/e2b)
 * disqualifies the box. Docker qualifies: its localhost sshd is key-authed by a
 * per-box key that persists under the box dir (only the loopback host port
 * changes across restart, and `agentbox open`/start re-syncs `~/.ssh/config`).
 */
export const PERSISTENT_SSH_PROVIDERS: readonly string[] = ['docker', 'hetzner'];

/**
 * Providers `agentbox code` can attach an IDE to: docker via the Dev Containers
 * attached-container URI, clouds via a Remote-SSH alias.
 */
export const IDE_PROVIDERS: readonly string[] = ['docker', 'hetzner', 'daytona'];

/**
 * Providers `agentbox open` can sshfs-mount `/workspace` from — they expose real
 * SSH: docker's localhost sshd, Hetzner's VPS, Daytona's token gateway. Vercel/E2B
 * have no SSH (their `buildAttach` yields a non-SSH `sbx exec` / SDK PTY bridge),
 * so `open` fails fast with a readable pointer to `agentbox download`. Plugin
 * providers stay opted out until they declare SSH support.
 */
export const SSH_MOUNT_PROVIDERS: readonly string[] = ['docker', 'hetzner', 'daytona'];

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
      available: pathHasBinary('code', seams) || pathHasBinary('cursor', seams),
      providers: [...IDE_PROVIDERS],
    },
    iterm2: {
      available: macAppInstalled('iTerm.app', seams),
    },
    finder: {
      // The OS file-manager reveal always works (Finder on macOS, xdg-open
      // elsewhere); provider gating is what limits `open` to SSH-capable boxes.
      available: true,
      providers: [...SSH_MOUNT_PROVIDERS],
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
