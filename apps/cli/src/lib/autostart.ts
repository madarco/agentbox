/**
 * Autostart for the exposed hub — bring the control box back after a reboot or
 * logout, so an always-on machine (a Mac mini, a NAS, a desktop) keeps serving
 * the hub without anyone logging in and re-running it.
 *
 * A launchd LaunchAgent on macOS, a systemd user unit on Linux. Both just run
 * `agentbox hub start`, which reads the exposed block from
 * `~/.agentbox/control-plane/deploy.json` and brings the hub up in the same mode
 * — so the unit carries no secrets and never drifts from the expose flags.
 *
 * The unit-body builders are pure (host + paths in, string out) so they're
 * unit-testable; the install/remove wrappers write the file and best-effort
 * register it with the platform's service manager.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

/** Reverse-DNS-ish label / unit name — matches the app's `sh.agent-box.*` id. */
export const LAUNCHD_LABEL = 'sh.agent-box.hub';
export const SYSTEMD_UNIT = 'agentbox-hub.service';

export function launchdPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home: string = homedir()): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

/** Where the autostart unit lives on this platform, or null when unsupported. */
export function autostartUnitPath(home: string = homedir()): string | null {
  if (platform() === 'darwin') return launchdPlistPath(home);
  if (platform() === 'linux') return systemdUnitPath(home);
  return null;
}

/** The command the unit runs: `<node> <cliEntry> hub start --no-open`. Pure. */
export interface AutostartInvocation {
  execPath: string;
  cliEntry: string;
}

/** launchd LaunchAgent plist. `RunAtLoad` + `KeepAlive` = start on login, restart on crash. */
export function launchdPlist(inv: AutostartInvocation, logFile: string): string {
  const args = [inv.execPath, inv.cliEntry, 'hub', 'start', '--no-open'];
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argXml,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** systemd user unit. `WantedBy=default.target` = start on (lingering) login. */
export function systemdUnit(inv: AutostartInvocation): string {
  const exec = [inv.execPath, inv.cliEntry, 'hub', 'start', '--no-open']
    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
    .join(' ');
  return [
    '[Unit]',
    'Description=AgentBox hub (control box)',
    'After=network-online.target docker.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Run a command detached, ignoring failures (the service manager is a nicety). */
function runQuiet(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolveP) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => resolveP());
      child.on('exit', () => resolveP());
    } catch {
      resolveP();
    }
  });
}

export interface AutostartResult {
  /** Where the unit was written, or null on an unsupported platform. */
  path: string | null;
  /** A one-line note for the user (e.g. the systemd linger hint), or null. */
  note: string | null;
}

/**
 * Install the autostart unit for `hub start` and register it with launchd /
 * systemd (best-effort). Returns the path written and any follow-up note.
 */
export async function installAutostart(
  inv: AutostartInvocation,
  opts: { logFile: string; home?: string } = { logFile: join(homedir(), '.agentbox', 'hub.log') },
): Promise<AutostartResult> {
  const home = opts.home ?? homedir();
  const os = platform();
  if (os === 'darwin') {
    const path = launchdPlistPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, launchdPlist(inv, opts.logFile));
    // Reload so it takes effect now, not just next login. bootout is a no-op the
    // first time; bootstrap (re)loads the fresh plist.
    const domain = `gui/${process.getuid?.() ?? ''}`;
    await runQuiet('launchctl', ['bootout', domain, path]);
    await runQuiet('launchctl', ['bootstrap', domain, path]);
    return { path, note: null };
  }
  if (os === 'linux') {
    const path = systemdUnitPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, systemdUnit(inv));
    await runQuiet('systemctl', ['--user', 'daemon-reload']);
    await runQuiet('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    return {
      path,
      // A user unit only survives logout if lingering is on for the user.
      note: `To keep the hub running after you log out: sudo loginctl enable-linger ${process.env.USER ?? '$USER'}`,
    };
  }
  return { path: null, note: `autostart is not supported on ${os} — start the hub manually after a reboot` };
}

/** Remove the autostart unit and deregister it (best-effort, idempotent). */
export async function removeAutostart(home: string = homedir()): Promise<void> {
  const os = platform();
  if (os === 'darwin') {
    const path = launchdPlistPath(home);
    const domain = `gui/${process.getuid?.() ?? ''}`;
    await runQuiet('launchctl', ['bootout', domain, path]);
    await rm(path, { force: true });
    return;
  }
  if (os === 'linux') {
    await runQuiet('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
    await rm(systemdUnitPath(home), { force: true });
    await runQuiet('systemctl', ['--user', 'daemon-reload']);
    return;
  }
}
