import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseProviderWarning } from '@agentbox/core';

export interface CommandLog {
  /** Absolute path agents can tail. */
  path: string;
  /** Append a line with an ISO timestamp prefix; a trailing newline is added if missing. */
  write(line: string): void;
  /** Append raw bytes verbatim — for subprocess streams that already carry their own newlines. */
  raw(chunk: string): void;
  /** Time a step; emits BEGIN/END markers and elapsed ms. On throw, emits FAIL and rethrows. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Lines a provider marked with `providerWarning()` — decisions the user must
   * still see once the spinner chrome they streamed through is gone. Collected
   * here rather than at each `onLog` site because a create wires five of them,
   * and a warning is worth exactly as much from any one.
   */
  warnings(): string[];
  /** Idempotent. */
  close(): void;
}

function stateDir(): string {
  return process.env.AGENTBOX_HOME ?? join(homedir(), '.agentbox');
}

function logsDir(): string {
  return join(stateDir(), 'logs');
}

/**
 * Open a fresh, tee'd log file for a CLI command. Rotates one generation:
 * any prior `<command>.log` becomes `<command>.log.prev`, replacing an
 * older prev. Also updates `<logsDir>/latest.log` to point at the active
 * file so an agent can tail one stable path without knowing the command.
 *
 * Writes are synchronous; callers can fire-and-forget from spinner
 * callbacks. The fd is closed on `close()` and on `process.exit` so a
 * crash still flushes everything that was written.
 */
/**
 * The log for the command currently running, when one opened a log at all.
 *
 * Exists so deep layers can record a decision without every caller threading a
 * logger down to them. The concrete case: `ensureImage`'s pull-vs-build progress
 * is wired only to a @clack spinner, which overwrites itself — so the single
 * most expensive branch in a create (pull a published image, or rebuild it for
 * ten minutes) left NO trace on disk, and a silently rate-limited pull was
 * indistinguishable from an unpublished tag when reading the logs afterwards.
 */
let activeCommandLog: CommandLog | null = null;

/**
 * Append to the active command log, if any. A no-op when nothing opened one
 * (a short command, or a unit test), so callers never need to check.
 */
export function logToActiveCommand(line: string): void {
  activeCommandLog?.write(line);
}

export function openCommandLog(command: string): CommandLog {
  const dir = logsDir();
  mkdirSync(dir, { recursive: true });

  const path = join(dir, `${command}.log`);
  const prev = join(dir, `${command}.log.prev`);
  try {
    // Move the previous run aside. EEXIST on rename is the typical case
    // (a `.prev` from the run before that) — overwrite it.
    renameSync(path, prev);
  } catch {
    /* nothing to rotate */
  }

  const fd = openSync(path, 'a');
  const startedAt = new Date().toISOString();
  writeSync(fd, `${startedAt} --- BEGIN ${command} (pid ${String(process.pid)}) ---\n`);

  updateLatestSymlink(dir, path);

  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    if (activeCommandLog === log) activeCommandLog = null;
    try {
      writeSync(fd, `${new Date().toISOString()} --- END ${command} ---\n`);
    } catch {
      /* fd already gone */
    }
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  };
  // Last-resort flush. Don't unhook anything else; this is purely additive.
  process.on('exit', closeOnce);

  const warnings: string[] = [];
  const log: CommandLog = {
    path,
    warnings(): string[] {
      return [...warnings];
    },
    write(line: string): void {
      if (closed) return;
      // Collect, but write the line through UNCHANGED. A queued job's log is a
      // transport, not just a record: the hub worker writes here and the CLI
      // streams those lines back, so stripping the marker at this end would
      // consume it before the process that has a terminal ever sees it. Keeping
      // it also makes a past warning greppable in `~/.agentbox/logs`.
      // De-duplicated: a retried step can emit the same warning twice.
      const marked = parseProviderWarning(line.trimEnd());
      if (marked && !warnings.includes(marked)) warnings.push(marked);
      const ts = new Date().toISOString();
      const body = line.endsWith('\n') ? line : line + '\n';
      try {
        writeSync(fd, `${ts} ${body}`);
      } catch {
        /* swallow — never break the command on log write failure */
      }
    },
    raw(chunk: string): void {
      if (closed) return;
      try {
        writeSync(fd, chunk);
      } catch {
        /* swallow */
      }
    },
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const t0 = Date.now();
      this.write(`--- BEGIN ${name} ---`);
      try {
        const out = await fn();
        this.write(`--- END ${name} (${String(Date.now() - t0)}ms) ---`);
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.write(`--- FAIL ${name} (${String(Date.now() - t0)}ms): ${msg} ---`);
        throw err;
      }
    },
    close: closeOnce,
  };
  activeCommandLog = log;
  return log;
}

function updateLatestSymlink(dir: string, target: string): void {
  const link = join(dir, 'latest.log');
  try {
    unlinkSync(link);
  } catch {
    /* not present */
  }
  try {
    symlinkSync(target, link);
  } catch {
    // Windows or restricted FS: leave a text pointer instead. Best-effort.
    try {
      writeFileSync(link, target + '\n');
    } catch {
      /* give up — symlink is a convenience, not a contract */
    }
  }
}
