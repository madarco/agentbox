/**
 * `agentbox app` — start / stop / restart / status for the AgentBox macOS menu-bar app.
 *
 * Drives the running process directly (`open` / `pkill` / `pgrep`) without touching the installed
 * bundle — the lightweight lifecycle control the tray otherwise lacks (only `agentbox install tray`
 * relaunches it). macOS-only; a clean, explained no-op elsewhere. The bundle install/uninstall lives
 * in `install-tray.ts`, which owns `APP_NAME` / `APP_PATH`.
 */

import { intro, log, outro, spinner } from '@clack/prompts';
import { Command } from 'commander';
import { execa } from 'execa';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AGENTBOX_VERSION } from '../version.js';
import { APP_BUNDLE_ID, APP_NAME, APP_PATH, LEGACY_APP_NAME } from './install-tray.js';

/** macOS writes app crash reports here as `AgentBox-<timestamp>.ips`. */
const DIAGNOSTIC_REPORTS_DIR = join(homedir(), 'Library/Logs/DiagnosticReports');
/** Unified-logging predicate scoping to the tray's subsystem. */
const LOG_PREDICATE = `subsystem == "${APP_BUNDLE_ID}"`;

/** True on macOS; otherwise print the standard no-op notice and let the caller return. */
function ensureMac(): boolean {
  if (process.platform === 'darwin') return true;
  log.info('The AgentBox menu-bar app is macOS-only.');
  return false;
}

/** PIDs of a process by exact executable name, or [] if none. `pgrep` exits 1 when nothing matches. */
async function pidsForName(name: string): Promise<number[]> {
  const res = await execa('pgrep', ['-x', name]).catch(() => null);
  if (!res) return [];
  return res.stdout
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * PIDs of the running app, or [] if none. Covers both the current (`AgentBox`) and the legacy
 * pre-rename (`AgentBoxTray`) executable names, so status/stop/restart still see a stray old process
 * during migration.
 */
async function trayPids(): Promise<number[]> {
  const [current, legacy] = await Promise.all([
    pidsForName(APP_NAME),
    pidsForName(LEGACY_APP_NAME),
  ]);
  return [...current, ...legacy];
}

async function startTray(): Promise<void> {
  await execa('open', [APP_PATH]);
}

async function stopTray(): Promise<void> {
  // `pkill` exits 1 when there was nothing to kill — not an error for us. Cover the legacy
  // pre-rename name too so `stop`/`restart` don't leave a stray old process alive.
  await execa('pkill', ['-x', APP_NAME]).catch(() => undefined);
  await execa('pkill', ['-x', LEGACY_APP_NAME]).catch(() => undefined);
}

/** True only when the bundle is present; guard `start`/`restart` and point at the installer. */
function ensureInstalled(): boolean {
  if (existsSync(APP_PATH)) return true;
  log.error(`${APP_PATH} is not installed. Run \`agentbox install tray\` first.`);
  process.exitCode = 1;
  return false;
}

interface CrashReport {
  name: string;
  path: string;
  mtimeMs: number;
}

// macOS names reports `AgentBox-<ts>.ips` (hyphen) today; allow an underscore too since some report
// types use it. Built from APP_NAME so it stays in sync (no regex-special chars in it).
const IPS_NAME = new RegExp(`^${APP_NAME}[-_].*\\.ips$`, 'i');

/**
 * Recent tray crash reports, newest first. [] if none. Scans the top level of DiagnosticReports
 * **and** its `Retired/` subdir — macOS moves older `.ips` reports there, so a top-level-only scan
 * would miss them.
 */
function listCrashReports(): CrashReport[] {
  const dirs = [DIAGNOSTIC_REPORTS_DIR, join(DIAGNOSTIC_REPORTS_DIR, 'Retired')];
  const reports: CrashReport[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // dir absent (no crash / no Retired yet) — not an error
    }
    for (const n of names) {
      if (!IPS_NAME.test(n)) continue;
      const path = join(dir, n);
      try {
        reports.push({ name: n, path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // vanished between readdir and stat — skip it, don't fail the whole command
      }
    }
  }
  return reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

interface UnifiedLogResult {
  text: string;
  /** Set when `log show` failed/timed out, so callers don't misread empty output as "no entries". */
  failureNote?: string;
}

/** Read the tray's unified-log entries for the given window via `log show`. */
async function trayUnifiedLog(last: string): Promise<UnifiedLogResult> {
  // `--info` surfaces info-level lines too (notice/error/fault always show). `reject:false`
  // so a slow/edge-case `log` exit resolves (with `failed`/`timedOut` set) rather than throwing —
  // we still want whatever it printed, plus a note explaining the shortfall.
  const res = await execa(
    'log',
    ['show', '--predicate', LOG_PREDICATE, '--last', last, '--style', 'compact', '--info'],
    { reject: false, timeout: 60_000 },
  );
  const text = res.stdout ?? '';
  if (res.failed) {
    const failureNote = res.timedOut
      ? '`log show` timed out after 60s — output above may be partial. Narrow --last for a faster query.'
      : `\`log show\` failed: ${(res.stderr || '').trim() || `exit code ${res.exitCode ?? 'unknown'}`}`;
    return { text, failureNote };
  }
  return { text };
}

/** Print the crash-report list (newest few) to stdout. */
function printCrashReports(reports: CrashReport[], limit = 5): void {
  if (reports.length === 0) {
    log.info('No crash reports found.');
    return;
  }
  log.info(`Crash reports (${reports.length}) in ${DIAGNOSTIC_REPORTS_DIR}:`);
  for (const r of reports.slice(0, limit)) {
    process.stdout.write(`  ${r.name}\t${new Date(r.mtimeMs).toISOString()}\n`);
  }
  if (reports.length > limit) {
    process.stdout.write(`  … and ${reports.length - limit} older. Use --open to reveal them.\n`);
  }
}

interface LogOpts {
  last: string;
  follow?: boolean;
  crashes?: boolean;
  open?: boolean;
  out?: string;
}

interface StatusOpts {
  json?: boolean;
}

const statusSub = new Command('status')
  .description('Show whether the AgentBox app is running, with pid(s)')
  .option('--json', 'emit { running, pids, installed, appPath } as JSON')
  .action(async (opts: StatusOpts) => {
    const mac = process.platform === 'darwin';
    const pids = mac ? await trayPids() : [];
    const installed = mac && existsSync(APP_PATH);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ running: pids.length > 0, pids, installed, appPath: APP_PATH }, null, 2) +
          '\n',
      );
      return;
    }
    if (!ensureMac()) return;
    if (pids.length) {
      log.info(`AgentBox is running (pid ${pids.join(', ')}).`);
    } else if (installed) {
      log.info('AgentBox is installed but not running.');
    } else {
      log.warn('AgentBox is not installed. Run `agentbox install tray`.');
    }
  });

const startSub = new Command('start')
  .description('Launch the AgentBox app if it is not already running')
  .action(async () => {
    if (!ensureMac()) return;
    intro('Starting AgentBox…');
    if ((await trayPids()).length) {
      outro('Already running');
      return;
    }
    if (!ensureInstalled()) {
      outro('Not started'); // close the clack session the `intro` above opened
      return;
    }
    await startTray();
    outro('Started (look for the box icon in the menu bar)');
  });

const stopSub = new Command('stop')
  .description('Quit the running AgentBox app (idempotent)')
  .action(async () => {
    if (!ensureMac()) return;
    intro('Stopping AgentBox…');
    if (!(await trayPids()).length) {
      outro('Not running');
      return;
    }
    await stopTray();
    outro('Stopped');
  });

const restartSub = new Command('restart')
  .description('Quit and relaunch the AgentBox app')
  .action(async () => {
    if (!ensureMac()) return;
    if (!ensureInstalled()) return;
    intro('Restarting AgentBox…');
    await stopTray();
    // Wait for the old process to actually exit before relaunching, else `open`
    // may just foreground the still-quitting instance.
    for (let i = 0; i < 20 && (await trayPids()).length; i++) await delay(100);
    await startTray();
    outro('Restarted');
  });

const logSub = new Command('log')
  .description("Show the tray app's diagnostics (unified log + crash reports) for bug reports")
  .option('-n, --last <window>', 'time window for the unified log (e.g. 30m, 2h, 1d)', '1h')
  .option('-f, --follow', 'stream live tray log entries instead of a snapshot')
  .option('--crashes', 'show only recent crash reports (skip the unified log)')
  .option('--open', 'reveal the crash-reports folder in Finder and exit')
  .option('--out <file>', 'write a self-contained bug-report bundle to <file>')
  .action(async (opts: LogOpts) => {
    if (!ensureMac()) return;

    if (opts.open) {
      await execa('open', [DIAGNOSTIC_REPORTS_DIR]).catch(() => undefined);
      log.info(`Opened ${DIAGNOSTIC_REPORTS_DIR}`);
      return;
    }

    if (opts.out) {
      await writeBugReportBundle(opts.out, opts.last);
      return;
    }

    if (opts.follow) {
      // Live stream; inherit stdio so Ctrl-C tears it down cleanly (mirrors `logs.ts`).
      const child = spawn(
        'log',
        ['stream', '--predicate', LOG_PREDICATE, '--style', 'compact', '--level', 'info'],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      const term = (): void => {
        child.kill('SIGTERM');
      };
      process.on('SIGINT', term);
      process.on('SIGTERM', term);
      await new Promise<void>((resolve) => {
        // `error` (not `exit`) fires if `log stream` fails to spawn — resolve so we don't hang.
        child.on('error', (err) => {
          log.error(`failed to start \`log stream\`: ${err.message}`);
          process.exitCode = 1;
          resolve();
        });
        // Propagate a genuine non-zero exit so scripts see the failure. A user Ctrl-C kills the
        // child by signal (code null) — that's a normal stop, not a failure.
        child.on('exit', (code) => {
          if (code && code !== 0) process.exitCode = code;
          resolve();
        });
      });
      return;
    }

    const reports = listCrashReports();

    if (opts.crashes) {
      printCrashReports(reports);
      return;
    }

    const s = spinner();
    s.start('Reading tray unified log…');
    const { text: logText, failureNote } = await trayUnifiedLog(opts.last);
    s.stop('Tray unified log');
    process.stdout.write(logText.endsWith('\n') || logText === '' ? logText : logText + '\n');
    if (failureNote) {
      log.warn(failureNote);
    } else if (logText.trim() === '') {
      log.info(
        `No log entries in the last ${opts.last}. The tray may not be running, or try a longer --last window.`,
      );
    }
    process.stdout.write('\n');
    printCrashReports(reports);
  });

/** Assemble a single attachable bug-report file: env header + unified log + newest crash. */
async function writeBugReportBundle(outPath: string, last: string): Promise<void> {
  const s = spinner();
  s.start('Collecting diagnostics…');

  const cliVersion = AGENTBOX_VERSION;
  const macVersion =
    (await execa('sw_vers', ['-productVersion'], { reject: false }).catch(() => null))?.stdout ??
    'unknown';
  const pids = await trayPids();
  const installed = existsSync(APP_PATH);
  const { text: logText, failureNote } = await trayUnifiedLog(last);
  const reports = listCrashReports();
  const newest = reports[0];
  let newestBody = '';
  if (newest) {
    try {
      newestBody = readFileSync(newest.path, 'utf8');
    } catch (err) {
      newestBody = `(failed to read ${newest.path}: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  const bundle = [
    '# AgentBox bug report',
    `generated (UTC): ${new Date().toISOString()}`,
    `agentbox CLI: ${cliVersion}`,
    `macOS: ${macVersion}`,
    `tray installed: ${installed} (${APP_PATH})`,
    `tray running: ${pids.length > 0}${pids.length ? ` (pid ${pids.join(', ')})` : ''}`,
    `crash reports: ${reports.length}${newest ? ` (newest ${newest.name})` : ''}`,
    '',
    `## Unified log (subsystem ${APP_BUNDLE_ID}, last ${last})`,
    '',
    ...(failureNote ? [`NOTE: ${failureNote}`, ''] : []),
    logText.trim() === '' ? '(no entries)' : logText.trimEnd(),
    '',
    '## Newest crash report',
    '',
    newest ? `file: ${newest.path}` : '(no crash reports)',
    '',
    newestBody.trimEnd(),
    '',
  ].join('\n');

  writeFileSync(outPath, bundle);
  s.stop('Diagnostics collected');
  log.info(`Wrote bug-report bundle to ${outPath}`);
}

export const appCommand = new Command('app')
  .description('Control the AgentBox menu-bar app (status / start / stop / restart / log)')
  .addCommand(statusSub, { isDefault: true })
  .addCommand(startSub)
  .addCommand(stopSub)
  .addCommand(restartSub)
  .addCommand(logSub);
