/**
 * State + IPC for the headless (`--headless` / non-TTY) `agentbox claude login`
 * flow. The login is a PKCE OAuth flow, so the process that prints the auth URL
 * must be the same one that exchanges the pasted code — it can't be split across
 * two independent CLI invocations. So a detached worker holds the live login
 * process while two short foreground calls coordinate with it through files
 * under `~/.agentbox/claude-login/<id>/`:
 *
 *   request.json  start → worker   { image, extraArgs, cwd, createdAt }
 *   state.json    worker → polls   { phase, url?, pid, ... } (atomically replaced)
 *   code          --code → worker  the pasted OAuth code (atomically created)
 *
 * All writers write a temp file then `rename` over the target (atomic on the
 * same filesystem); readers tolerate a transient ENOENT mid-rename.
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
import { homedir } from 'node:os';
import { join } from 'node:path';

export type LoginPhase = 'starting' | 'awaiting-code' | 'exchanging' | 'done' | 'error';

export interface LoginState {
  phase: LoginPhase;
  /** OAuth URL the user must approve; present from `awaiting-code` onward. */
  url?: string;
  /** Worker pid — readers use it to tell a live session from a crashed one. */
  pid: number;
  createdAt: string;
  updatedAt: string;
  /** Warm-up result (the sacrificial first-request absorb), set on `done`. */
  warmed?: boolean;
  /** A recoverable problem (e.g. a rejected code) — session stays usable. */
  lastError?: string;
  /** A terminal failure reason, set with phase `error`. */
  error?: string;
  /** Login process exit code, when it exited. */
  exitCode?: number;
}

export interface LoginRequest {
  image: string;
  extraArgs: string[];
  cwd: string;
  createdAt: string;
}

export type LoginMode = 'code' | 'headless' | 'interactive';

/**
 * Pick the login flavor from the invocation shape. `--code` always means
 * "deliver a code to a pending session". Otherwise a real TTY gets today's
 * fully-interactive flow; anything non-interactive (orchestrator pipe, CI) or
 * an explicit `--headless` gets the two-call worker flow.
 */
export function selectLoginMode(o: {
  isTTY: boolean;
  headless: boolean;
  code: boolean;
}): LoginMode {
  if (o.code) return 'code';
  if (o.headless || !o.isTTY) return 'headless';
  return 'interactive';
}

/** `~/.agentbox` honoring `AGENTBOX_HOME` (mirrors lib/log-file.ts). */
function stateDir(): string {
  return process.env.AGENTBOX_HOME ?? join(homedir(), '.agentbox');
}
export function loginRootDir(): string {
  return join(stateDir(), 'claude-login');
}
export function loginSessionDir(id: string): string {
  return join(loginRootDir(), id);
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJsonWithRetry<T>(path: string): T | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      // A read that races a rename can see ENOENT or a partial file; retry once.
    }
  }
  return null;
}

export function writeLoginRequest(id: string, req: LoginRequest): void {
  mkdirSync(loginSessionDir(id), { recursive: true });
  atomicWrite(join(loginSessionDir(id), 'request.json'), JSON.stringify(req));
}
export function readLoginRequest(id: string): LoginRequest | null {
  return readJsonWithRetry<LoginRequest>(join(loginSessionDir(id), 'request.json'));
}

export function writeLoginState(id: string, state: Omit<LoginState, 'updatedAt'>): void {
  mkdirSync(loginSessionDir(id), { recursive: true });
  const full: LoginState = { ...state, updatedAt: new Date().toISOString() };
  atomicWrite(join(loginSessionDir(id), 'state.json'), JSON.stringify(full));
}
export function readLoginState(id: string): LoginState | null {
  return readJsonWithRetry<LoginState>(join(loginSessionDir(id), 'state.json'));
}

export function writeLoginCode(id: string, code: string): void {
  mkdirSync(loginSessionDir(id), { recursive: true });
  atomicWrite(join(loginSessionDir(id), 'code'), code.trim());
}
/** Read and consume the pasted code (deleting it so a retry can deliver a new one). */
export function takeLoginCode(id: string): string | null {
  const path = join(loginSessionDir(id), 'code');
  try {
    const code = readFileSync(path, 'utf8').trim();
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function listSessions(): string[] {
  try {
    return readdirSync(loginRootDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The single live session still waiting for a code (worker process alive). The
 * normal flow only ever has one; if a future caller starts several, the first
 * live one wins and the caller can disambiguate with `--session`.
 */
export function findPendingSession(): { id: string; state: LoginState } | null {
  for (const id of listSessions()) {
    const state = readLoginState(id);
    if (state && state.phase === 'awaiting-code' && pidAlive(state.pid)) {
      return { id, state };
    }
  }
  return null;
}

/**
 * Any live (worker-alive) session in a non-terminal phase — including `starting`
 * (URL not published yet) and `exchanging`. The start guard uses THIS, not
 * {@link findPendingSession}: blocking only on `awaiting-code` would let a second
 * `--headless` slip through during the brief `starting` window and spawn a
 * duplicate worker, breaking the single-session PKCE assumption.
 */
export function findLiveSession(): { id: string; state: LoginState } | null {
  for (const id of listSessions()) {
    const state = readLoginState(id);
    if (state && state.phase !== 'done' && state.phase !== 'error' && pidAlive(state.pid)) {
      return { id, state };
    }
  }
  return null;
}

/**
 * Reap finished/dead/old session dirs. Removed when: the worker pid is dead and
 * the phase isn't terminal (crash), the phase is terminal and older than 5 min,
 * or the state is missing/older than 15 min (stuck/abandoned).
 */
export function cleanupStaleSessions(now: number = Date.now()): void {
  const TERMINAL_MAX_AGE = 5 * 60_000;
  const STUCK_MAX_AGE = 15 * 60_000;
  for (const id of listSessions()) {
    const dir = loginSessionDir(id);
    const state = readLoginState(id);
    let stale = false;
    if (!state) {
      stale = true;
    } else {
      const age = now - Date.parse(state.updatedAt);
      const terminal = state.phase === 'done' || state.phase === 'error';
      if (terminal) {
        stale = age > TERMINAL_MAX_AGE;
      } else if (!pidAlive(state.pid)) {
        stale = true;
      } else {
        stale = age > STUCK_MAX_AGE;
      }
    }
    if (stale) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

// Strip CSI (color/cursor) escapes only. OSC hyperlinks (OSC 8) embed the URL
// itself, so leaving them in lets the URL regex still match inside them. Built
// via RegExp(string) so the ESC byte and the `/` intermediate stay unambiguous.
const CSI = new RegExp('\\u001b\\[[0-9;?]*[ -\\/]*[@-~]', 'g');
// Match an OAuth approval URL on any current Claude/Anthropic auth host
// (claude.com/cai/oauth/…, claude.ai, console.anthropic.com) and REQUIRE the
// literal `oauth` in the path/query so an unrelated claude.com link can't
// match. The char class excludes whitespace, quotes/brackets, and control bytes
// (so an OSC-8 hyperlink's trailing BEL terminates the match cleanly).
const URL_BODY = "[^\\s'\"`<>)\\]\\u0000-\\u001f]";
const OAUTH_URL = new RegExp(
  `https?://(?:claude\\.com|claude\\.ai|console\\.anthropic\\.com)/${URL_BODY}*oauth${URL_BODY}*`,
  'i',
);

/**
 * Pull the OAuth approval URL out of accumulated (possibly ANSI-styled) login
 * output. Claude's `--claudeai` paste-code flow prints a
 * `https://claude.ai/oauth/authorize?...` (or console.anthropic.com) link. We
 * strip color escapes first, then match the first such URL; surrounding
 * quotes/brackets and trailing punctuation are trimmed.
 */
export function extractOAuthUrl(text: string): string | null {
  const clean = text.replace(CSI, '');
  const m = clean.match(OAUTH_URL);
  if (!m) return null;
  return m[0].replace(/["'`)\]>]+$/, '').replace(/[.,;]+$/, '');
}
