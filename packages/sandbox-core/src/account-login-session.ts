/**
 * A hub-driven sign-in of an LLM account (docs/credentials-tui-plan.md,
 * Phase 2): `POST /api/v1/accounts/:agent/:id/login` starts the agent's own
 * login in a throwaway container on the hub's machine, the client opens the
 * URL it prints, pastes the code back (claude) or just approves (codex device
 * auth), and the new login replaces the stored one.
 *
 * The OAuth flow is PKCE, so the process that printed the URL must be the one
 * that exchanges the code: a detached CLI worker
 * (`agentbox _account-login-worker <id>`) holds it for the whole session, and
 * the hub talks to it through files under `~/.agentbox/account-login/<id>/`:
 *
 *   request.json  hub → worker     what to sign in ({@link AccountLoginRequest})
 *   state.json    worker → hub     where it is ({@link AccountLoginWorkerState})
 *   code          hub → worker     the pasted code, consumed on read
 *   renew.json    hub only         the fan-out's outcome after the sign-in
 *   cancel        hub → worker     stop (before the worker has a pid to signal)
 *
 * Every writer writes a temp file and renames it over the target; readers
 * tolerate a transient miss. The code is a secret in transit: 0600, deleted on
 * read, never logged.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './state.js';

export type AccountLoginMode = 'add' | 'renew';

export interface AccountLoginRequest {
  agent: string;
  account: string;
  mode: AccountLoginMode;
  createdAt: string;
}

/**
 * The worker's phases. `signed-in` is its last good one: the login is stored;
 * the hub then fans it out to the account's boxes.
 */
export type AccountLoginWorkerPhase =
  | 'starting'
  | 'awaiting-code'
  | 'awaiting-approval'
  | 'exchanging'
  | 'signed-in'
  | 'error';

export interface AccountLoginWorkerState {
  phase: AccountLoginWorkerPhase;
  /** The page to open: the OAuth approval (claude) or the device page (codex). */
  url?: string;
  /** The one-time code the device page asks for (codex). */
  userCode?: string;
  /** What `awaiting-code` wants typed: the browser's code, or a secret (its label). */
  input?: { kind: 'code' } | { kind: 'secret'; label: string };
  /** A rejected code: the session is still waiting for a fresh one. */
  lastError?: string;
  /** Why the session ended, with phase `error`. */
  error?: string;
  /** Who signed in (display only), with `signed-in`. */
  identity?: { email?: string; org?: string; plan?: string };
  pid: number;
  updatedAt: string;
}

export interface AccountLoginRenewState {
  pushed: number;
  failed: number;
  output: string[];
  /** The fan-out could not run at all. */
  error?: string;
  at: string;
}

export function accountLoginRootDir(stateDir: string = STATE_DIR): string {
  return join(stateDir, 'account-login');
}

export function accountLoginDir(id: string, stateDir: string = STATE_DIR): string {
  return join(accountLoginRootDir(stateDir), id);
}

/** A session id from a client is used in a path: only what we mint is accepted. */
export function isAccountLoginId(id: string): boolean {
  return /^[a-z0-9]{8,32}$/.test(id);
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      // A read racing a rename sees ENOENT or a partial file; retry once.
    }
  }
  return null;
}

function sessionFile(id: string, name: string, stateDir?: string): string {
  return join(accountLoginDir(id, stateDir), name);
}

function ensureDir(id: string, stateDir?: string): void {
  mkdirSync(accountLoginDir(id, stateDir), { recursive: true, mode: 0o700 });
}

export function writeAccountLoginRequest(
  id: string,
  req: AccountLoginRequest,
  stateDir?: string,
): void {
  ensureDir(id, stateDir);
  atomicWrite(sessionFile(id, 'request.json', stateDir), JSON.stringify(req));
}

export function readAccountLoginRequest(id: string, stateDir?: string): AccountLoginRequest | null {
  return readJson<AccountLoginRequest>(sessionFile(id, 'request.json', stateDir));
}

export function writeAccountLoginState(
  id: string,
  state: Omit<AccountLoginWorkerState, 'updatedAt'>,
  stateDir?: string,
): void {
  ensureDir(id, stateDir);
  const full: AccountLoginWorkerState = { ...state, updatedAt: new Date().toISOString() };
  atomicWrite(sessionFile(id, 'state.json', stateDir), JSON.stringify(full));
}

export function readAccountLoginState(
  id: string,
  stateDir?: string,
): AccountLoginWorkerState | null {
  return readJson<AccountLoginWorkerState>(sessionFile(id, 'state.json', stateDir));
}

export function writeAccountLoginCode(id: string, code: string, stateDir?: string): void {
  ensureDir(id, stateDir);
  atomicWrite(sessionFile(id, 'code', stateDir), code.trim());
}

/**
 * Read and consume the pasted code (null when none is waiting). Claimed by a
 * rename first, so a code written while this one is read is never deleted
 * unread.
 */
export function takeAccountLoginCode(id: string, stateDir?: string): string | null {
  const path = sessionFile(id, 'code', stateDir);
  const claim = `${path}.taking.${String(process.pid)}`;
  try {
    renameSync(path, claim);
  } catch {
    return null;
  }
  try {
    const code = readFileSync(claim, 'utf8').trim();
    return code.length > 0 ? code : null;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      /* already gone */
    }
  }
}

/** Ask the worker to stop: works before it has published a pid to signal. */
export function writeAccountLoginCancel(id: string, stateDir?: string): void {
  ensureDir(id, stateDir);
  atomicWrite(sessionFile(id, 'cancel', stateDir), new Date().toISOString());
}

export function isAccountLoginCancelled(id: string, stateDir?: string): boolean {
  try {
    readFileSync(sessionFile(id, 'cancel', stateDir));
    return true;
  } catch {
    return false;
  }
}

export function writeAccountLoginRenew(
  id: string,
  renew: Omit<AccountLoginRenewState, 'at'>,
  stateDir?: string,
): void {
  ensureDir(id, stateDir);
  atomicWrite(
    sessionFile(id, 'renew.json', stateDir),
    JSON.stringify({ ...renew, at: new Date().toISOString() }),
  );
}

export function readAccountLoginRenew(
  id: string,
  stateDir?: string,
): AccountLoginRenewState | null {
  return readJson<AccountLoginRenewState>(sessionFile(id, 'renew.json', stateDir));
}

export function listAccountLoginSessions(stateDir?: string): string[] {
  try {
    return readdirSync(accountLoginRootDir(stateDir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && isAccountLoginId(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function removeAccountLoginSession(id: string, stateDir?: string): void {
  try {
    rmSync(accountLoginDir(id, stateDir), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Whether a session's worker still runs (sync; EPERM still means it exists). */
export function loginWorkerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True for a worker phase that ends the sign-in. */
export function isTerminalLoginPhase(phase: AccountLoginWorkerPhase): boolean {
  return phase === 'signed-in' || phase === 'error';
}
