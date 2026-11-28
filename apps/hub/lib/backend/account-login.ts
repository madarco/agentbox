// A hub-driven sign-in of an LLM account (docs/credentials-tui-plan.md,
// Phase 2): `/api/v1/accounts/:agent/:id/login`. The hub starts the agent's own
// login on ITS machine (a detached CLI worker holding the login container, so
// the PKCE URL-printer is the code-exchanger), the client opens the URL and
// pastes the code back (claude) or just approves (codex device auth), and the
// new login replaces the stored one. Then the existing renew fan-out pushes it
// to the account's boxes, so running boxes keep working. Works for a new
// account (add) and for a renew, on a local hub and on a control box alike:
// the store is always the hub machine's own.
//
// The code is a secret in transit: it travels only in a request body and the
// session's 0600 `code` file, never in a URL, a log line or a response.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  agentAccountKinds,
  findAccount,
  normalizeAccountName,
  type AgentSyncSpec,
} from '@agentbox/core';
import {
  findAgentSpec,
  isAccountLoginId,
  isTerminalLoginPhase,
  listAccountLoginSessions,
  isAccountLoginWorker,
  loginWorkerAlive,
  readAccountLoginRenew,
  readAccountLoginRequest,
  readAccountLoginState,
  readAccounts,
  removeAccountLoginSession,
  writeAccountLoginCancel,
  writeAccountLoginCode,
  writeAccountLoginRenew,
  writeAccountLoginRequest,
  writeAccountLoginState,
  type AccountLoginMode,
  type AccountLoginRequest,
  type AccountLoginWorkerState,
  type AccountStoreOptions,
} from '@agentbox/sandbox-core';
import type {
  AccountLoginBackend,
  AccountLoginView,
  AccountRenewView,
  AccountResult,
} from '../boxes/backend-types';

export interface AccountLoginDeps {
  /** The renew fan-out (`POST …/renew`), run once the login is stored. */
  renew: (agent: string, id: string) => Promise<AccountResult<AccountRenewView>>;
  /** Start the worker for a session; returns its pid. Default: the hub's CLI entry, detached. */
  spawnWorker?: (session: string) => number | undefined;
  store?: AccountStoreOptions;
  /** Where the session dirs live (tests); default `~/.agentbox`. */
  stateDir?: string;
  /** How long `start` waits for the URL before answering `starting` (default 20 s). */
  startWaitMs?: number;
  /** How long a code submit waits for the verdict (default 30 s). */
  codeWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  /**
   * Whether `pid` is this session's worker (tests); default: its command line
   * names `_account-login-worker <session>`, so a reused pid is never signalled.
   */
  isWorker?: (pid: number, session: string) => boolean;
  /**
   * The docker volumes a sign-in left (`<volume>-signin-<session>`), and their
   * removal (tests); default: the docker CLI.
   */
  scratchVolumes?: {
    list: () => Promise<string[]>;
    remove: (name: string) => Promise<void>;
  };
}

const execFileAsync = promisify(execFile);

const dockerScratchVolumes = {
  async list(): Promise<string[]> {
    const r = await execFileAsync('docker', ['volume', 'ls', '-q', '--filter', 'name=-signin-']);
    return r.stdout.split('\n').filter(Boolean);
  },
  async remove(name: string): Promise<void> {
    await execFileAsync('docker', ['volume', 'rm', '-f', name]);
  },
};

/** A finished session is kept this long for `GET` to report it, then reaped. */
const KEEP_FINISHED_MS = 30 * 60_000;
/** A session nobody finished in this long is cancelled (the worker's own wait is 10 min). */
const STUCK_MS = 20 * 60_000;
const MAX_LIVE_SESSIONS = 4;
/** A worker that has not written its first state in this long never started. */
const WORKER_BOOT_MS = 60_000;

function defaultSpawnWorker(session: string): number | undefined {
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry || !existsSync(entry)) {
    throw new Error('hub is missing AGENTBOX_CLI_ENTRY; cannot start a sign-in');
  }
  const child = spawn(process.execPath, [entry, '_account-login-worker', session], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child.pid;
}

/**
 * The session a scratch volume belongs to, or null when the name is not one
 * the sign-in worker minted (`agentbox-…-signin-<16 hex>`): the sweep must
 * never touch a user's own volume that merely contains `-signin-`. Pure.
 */
export function signinScratchSession(name: string): string | null {
  return /^agentbox-[a-z0-9._-]+-signin-([0-9a-f]{16})$/.exec(name)?.[1] ?? null;
}

/** The client view of a session (pure). */
export function accountLoginView(
  session: string,
  req: AccountLoginRequest,
  st: AccountLoginWorkerState | null,
  renew: ReturnType<typeof readAccountLoginRenew>,
): AccountLoginView {
  const phase = st?.phase ?? 'starting';
  const state: AccountLoginView['state'] =
    phase === 'signed-in' ? (renew ? 'done' : 'pushing') : phase;
  return {
    session,
    agent: req.agent,
    account: req.account,
    mode: req.mode,
    state,
    ...(st?.url ? { url: st.url } : {}),
    ...(st?.userCode ? { userCode: st.userCode } : {}),
    ...(phase === 'awaiting-code' && st?.input ? { input: st.input } : {}),
    ...(st?.lastError ? { lastError: st.lastError } : {}),
    ...(phase === 'error' && st?.error ? { error: st.error } : {}),
    ...(st?.identity ? { identity: st.identity } : {}),
    ...(phase === 'error' && st?.mismatch ? { mismatch: st.mismatch } : {}),
    ...(renew
      ? {
          renew: {
            pushed: renew.pushed,
            failed: renew.failed,
            output: renew.output,
            ...(renew.error ? { error: renew.error } : {}),
          },
        }
      : {}),
    startedAt: req.createdAt,
    updatedAt: st?.updatedAt ?? req.createdAt,
  };
}

export function createAccountLoginBackend(deps: AccountLoginDeps): AccountLoginBackend {
  const stateDir = deps.stateDir;
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 500;
  const startWaitMs = deps.startWaitMs ?? 20_000;
  const codeWaitMs = deps.codeWaitMs ?? 30_000;
  /** Sessions this hub process is watching (fan-out on `signed-in`). */
  const watching = new Set<string>();
  /**
   * A pid once verified as a session's worker stays verified while it lives:
   * the command-line check (a `ps` fork where there is no /proc) runs once per
   * session, not on every poll.
   */
  const verified = new Map<string, number>();
  const isWorker =
    deps.isWorker ??
    ((pid: number, session: string): boolean => {
      if (verified.get(session) === pid) {
        if (loginWorkerAlive(pid)) return true;
        verified.delete(session);
        return false;
      }
      if (!isAccountLoginWorker(pid, session)) return false;
      verified.set(session, pid);
      return true;
    });
  /** Signal the session's worker, only when the pid is still that worker. */
  const signal = (session: string, pid: number, sig: NodeJS.Signals): void => {
    if (pid <= 0 || !isWorker(pid, session)) return;
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * The worker's state, with a crashed worker (pid gone mid-flow) turned into
   * an `error`, written back so every later read agrees.
   */
  function stateOf(session: string): AccountLoginWorkerState | null {
    const st = readAccountLoginState(session, stateDir);
    if (!st) {
      // Only the worker writes its state; until its first write the session
      // reads `starting`, and one that never writes is a worker that never ran.
      const req = readAccountLoginRequest(session, stateDir);
      const age = now() - Date.parse(req?.createdAt ?? '');
      if (!req || !(age > WORKER_BOOT_MS)) return null;
      writeAccountLoginState(
        session,
        { phase: 'error', error: 'the sign-in worker never started', pid: 0 },
        stateDir,
      );
      return readAccountLoginState(session, stateDir);
    }
    if (isTerminalLoginPhase(st.phase) || isWorker(st.pid, session)) return st;
    const error = 'the sign-in stopped before it finished';
    writeAccountLoginState(session, { ...st, phase: 'error', error }, stateDir);
    return readAccountLoginState(session, stateDir);
  }

  function viewOf(session: string): AccountLoginView | null {
    const req = readAccountLoginRequest(session, stateDir);
    if (!req) return null;
    return accountLoginView(
      session,
      req,
      stateOf(session),
      readAccountLoginRenew(session, stateDir),
    );
  }

  /** Every session of this account, newest first. */
  function sessionsOf(agent: string, id: string): string[] {
    return listAccountLoginSessions(stateDir)
      .map((s) => ({ s, req: readAccountLoginRequest(s, stateDir) }))
      .filter(({ req }) => req?.agent === agent && req.account === id)
      .sort((a, b) => Date.parse(b.req!.createdAt) - Date.parse(a.req!.createdAt))
      .map(({ s }) => s);
  }

  const isLive = (session: string): boolean => {
    const st = stateOf(session);
    if (st === null) return readAccountLoginRequest(session, stateDir) !== null;
    return !isTerminalLoginPhase(st.phase);
  };

  /**
   * The (agent, account) a client's path names, as `start` stored it: the
   * agent's canonical id, and the account as typed or, failing that, its
   * normalized name ("Work Max" -> work_max).
   */
  function keyOf(agent: string, id: string): { agent: string; id: string } {
    const a = findAgentSpec(agent)?.id ?? agent;
    const raw = id.trim();
    if (sessionsOf(a, raw).length > 0) return { agent: a, id: raw };
    const n = normalizeAccountName(raw);
    return { agent: a, id: n.problem === undefined ? n.name : raw };
  }

  /**
   * Drop the scratch volumes of sign-ins that are over: a worker that was
   * killed or crashed leaves one holding a live credential and a copy of the
   * host config. A volume still in use is left for the next sweep.
   */
  const scratch = deps.scratchVolumes ?? dockerScratchVolumes;
  async function sweepScratchVolumes(): Promise<void> {
    const names = await scratch.list().catch(() => [] as string[]);
    for (const name of names) {
      const session = signinScratchSession(name);
      if (!session || isLive(session)) continue;
      await scratch.remove(name).catch(() => undefined);
    }
  }

  /** Cancel the stuck, drop the long finished and their scratch volumes. */
  function reap(): void {
    void sweepScratchVolumes();
    for (const s of listAccountLoginSessions(stateDir)) {
      const req = readAccountLoginRequest(s, stateDir);
      const st = stateOf(s);
      const age = now() - Date.parse(st?.updatedAt ?? req?.createdAt ?? '');
      if (!req || !Number.isFinite(age)) {
        removeAccountLoginSession(s, stateDir);
      } else if (st && !isTerminalLoginPhase(st.phase)) {
        const stuckFor = now() - Date.parse(req.createdAt) - STUCK_MS;
        if (stuckFor > 0) {
          // Asked first; a worker that ignored it for two more minutes is killed.
          writeAccountLoginCancel(s, stateDir);
          signal(s, st.pid, stuckFor > 2 * 60_000 ? 'SIGKILL' : 'SIGTERM');
        }
      } else if (age > KEEP_FINISHED_MS && !watching.has(s)) {
        removeAccountLoginSession(s, stateDir);
      }
    }
  }

  /**
   * Fan the new login out once it is stored. Idempotent and restart-safe: a
   * session that reached `signed-in` while no hub watched it is picked up by
   * the next read.
   */
  function watch(session: string): void {
    if (watching.has(session)) return;
    watching.add(session);
    void (async () => {
      try {
        for (;;) {
          const st = stateOf(session);
          // No state yet: the worker is still booting (stateOf turns one that
          // never writes into an error after WORKER_BOOT_MS, which ends this).
          if (!st) {
            if (!readAccountLoginRequest(session, stateDir)) return;
            await sleep(pollMs);
            continue;
          }
          if (st.phase === 'error') return;
          if (st.phase === 'signed-in') break;
          await sleep(pollMs);
        }
        if (readAccountLoginRenew(session, stateDir)) return;
        const req = readAccountLoginRequest(session, stateDir);
        if (!req) return;
        let r: AccountResult<AccountRenewView>;
        try {
          r = await deps.renew(req.agent, req.account);
        } catch (err) {
          r = {
            ok: false,
            code: 'conflict',
            error: err instanceof Error ? err.message : String(err),
          };
        }
        writeAccountLoginRenew(
          session,
          r.ok
            ? { pushed: r.value.pushed, failed: r.value.failed, output: r.value.output }
            : { pushed: 0, failed: 0, output: [], error: r.error },
          stateDir,
        );
      } finally {
        watching.delete(session);
      }
    })();
  }

  function resolveSpec(agent: string): AgentSyncSpec | string {
    const spec =
      (deps.store?.specs ?? undefined)?.find((s) => s.id === agent) ?? findAgentSpec(agent);
    if (!spec) return 'unknown agent';
    if (!spec.credential || !agentAccountKinds(spec).includes('login')) {
      return `${spec.id} has no sign-in to run from the hub`;
    }
    return spec;
  }

  async function waitFor(
    session: string,
    done: (v: AccountLoginView) => boolean,
    ms: number,
  ): Promise<AccountLoginView | null> {
    const deadline = now() + ms;
    for (;;) {
      const v = viewOf(session);
      if (!v || done(v) || now() >= deadline) return v;
      await sleep(pollMs);
    }
  }

  // A hub restart mid-sign-in: the detached worker kept going, but nothing
  // watched it. Resume every session still in flight or signed in without its
  // fan-out, so the login reaches the boxes with no client polling.
  // Deferred: off the hub's boot path (a `ps` per session where there is no /proc).
  setImmediate(() => {
    for (const s of listAccountLoginSessions(stateDir)) {
      const v = viewOf(s);
      if (v && v.state !== 'done' && v.state !== 'error') watch(s);
    }
    void sweepScratchVolumes();
  });

  return {
    async startAccountLogin(agent, rawId, input) {
      const spec = resolveSpec(agent);
      if (typeof spec === 'string') return { ok: false, code: 'not_found', error: spec };
      const body = (input ?? {}) as { mode?: unknown; replace?: unknown };
      if (body.replace !== undefined && typeof body.replace !== 'boolean') {
        return { ok: false, code: 'invalid_request', error: 'replace must be a boolean' };
      }
      if (body.mode !== undefined && body.mode !== 'add' && body.mode !== 'renew') {
        return { ok: false, code: 'invalid_request', error: 'mode must be "add" or "renew"' };
      }
      const file = await readAccounts(deps.store);
      // An existing name is taken as is (older ones may hold '-'); a new one
      // is normalized ("Work Max" -> work_max) or refused.
      let id = rawId.trim();
      let existing = findAccount(file, spec.id, id);
      if (!existing) {
        const n = normalizeAccountName(id);
        if (n.problem !== undefined)
          return { ok: false, code: 'invalid_request', error: n.problem };
        id = n.name;
        existing = findAccount(file, spec.id, id);
      }
      if (existing && existing.kind !== 'login') {
        return {
          ok: false,
          code: 'invalid_request',
          error: `${spec.id}/${id} is a ${existing.kind}: replace its token instead`,
        };
      }
      const mode: AccountLoginMode = existing ? 'renew' : 'add';
      if (body.mode === 'add' && existing) {
        return { ok: false, code: 'conflict', error: `${spec.id}/${id} already exists; renew it` };
      }
      if (body.mode === 'renew' && !existing) {
        return { ok: false, code: 'not_found', error: `no ${spec.id} account '${id}'` };
      }

      reap();
      // One sign-in per account: a second start answers the one in flight.
      const live = sessionsOf(spec.id, id).find(isLive);
      if (
        live &&
        body.replace === true &&
        readAccountLoginRequest(live, stateDir)?.replace !== true
      ) {
        // Joining would drop the replace silently.
        return {
          ok: false,
          code: 'conflict',
          error: `a sign-in of ${spec.id}/${id} is already in flight without replace; cancel it first`,
        };
      }
      if (live) {
        watch(live);
        return { ok: true, value: viewOf(live)! };
      }
      if (listAccountLoginSessions(stateDir).filter(isLive).length >= MAX_LIVE_SESSIONS) {
        return {
          ok: false,
          code: 'conflict',
          error: 'too many sign-ins in flight; finish one first',
        };
      }

      const session = randomBytes(8).toString('hex');
      const createdAt = new Date(now()).toISOString();
      writeAccountLoginRequest(
        session,
        {
          agent: spec.id,
          account: id,
          mode,
          createdAt,
          ...(body.replace === true ? { replace: true } : {}),
        },
        stateDir,
      );
      try {
        spawnWorker(session);
      } catch (err) {
        removeAccountLoginSession(session, stateDir);
        return {
          ok: false,
          code: 'conflict',
          error: err instanceof Error ? err.message : String(err),
        };
      }
      watch(session);
      const v = await waitFor(session, (x) => x.state !== 'starting', startWaitMs);
      return { ok: true, value: v ?? viewOf(session)! };
    },

    async getAccountLogin(rawAgent, rawId, session) {
      const { agent, id } = keyOf(rawAgent, rawId);
      if (session !== undefined && !isAccountLoginId(session)) {
        return { ok: false, code: 'invalid_request', error: 'bad session id' };
      }
      const s = session ?? sessionsOf(agent, id)[0];
      const v = s ? viewOf(s) : null;
      if (!s || !v || v.agent !== agent || v.account !== id) {
        return { ok: false, code: 'not_found', error: `no sign-in for ${agent}/${id}` };
      }
      // Restart-safe and client-independent: any live session is watched, so
      // the fan-out runs even if nobody polls after the code is taken.
      if (v.state !== 'done' && v.state !== 'error') watch(s);
      return { ok: true, value: v };
    },

    async submitAccountLoginCode(rawAgent, rawId, input) {
      const { agent, id } = keyOf(rawAgent, rawId);
      const b = (input ?? {}) as { code?: unknown; session?: unknown };
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      if (!code) return { ok: false, code: 'invalid_request', error: 'code is required' };
      if (code.length > 4096 || /[\r\n]/.test(code)) {
        return { ok: false, code: 'invalid_request', error: 'that is not a sign-in code' };
      }
      if (
        b.session !== undefined &&
        (typeof b.session !== 'string' || !isAccountLoginId(b.session))
      ) {
        return { ok: false, code: 'invalid_request', error: 'bad session id' };
      }
      const s = (b.session as string | undefined) ?? sessionsOf(agent, id).find(isLive);
      const v = s ? viewOf(s) : null;
      if (!s || !v || v.agent !== agent || v.account !== id) {
        return { ok: false, code: 'not_found', error: `no sign-in in flight for ${agent}/${id}` };
      }
      if (v.state !== 'awaiting-code') {
        return {
          ok: false,
          code: 'conflict',
          error: `the sign-in is not waiting for a code (it is ${v.state})`,
        };
      }
      const before = v.updatedAt;
      writeAccountLoginCode(s, code, stateDir);
      // The fan-out must not depend on a client polling to `pushing`.
      watch(s);
      // The verdict: stored (pushing/done), refused (back to awaiting-code
      // with a lastError), or failed.
      const out = await waitFor(
        s,
        (x) =>
          x.state === 'pushing' ||
          x.state === 'done' ||
          x.state === 'error' ||
          (x.state === 'awaiting-code' && x.lastError !== undefined && x.updatedAt > before),
        codeWaitMs,
      );
      return { ok: true, value: out ?? v };
    },

    async cancelAccountLogin(rawAgent, rawId, session) {
      if (session !== undefined && !isAccountLoginId(session)) {
        return { ok: false, code: 'invalid_request', error: 'bad session id' };
      }
      const { agent, id } = keyOf(rawAgent, rawId);
      // With a session, only that one: closing one client's dialog must not
      // cancel the sign-in another client is in the middle of.
      const s = session
        ? sessionsOf(agent, id).includes(session) && isLive(session)
          ? session
          : undefined
        : sessionsOf(agent, id).find(isLive);
      if (!s)
        return { ok: false, code: 'not_found', error: `no sign-in in flight for ${agent}/${id}` };
      writeAccountLoginCancel(s, stateDir);
      const st = readAccountLoginState(s, stateDir);
      if (st) signal(s, st.pid, 'SIGTERM');
      const v = await waitFor(s, (x) => x.state === 'error' || x.state === 'done', 5_000);
      return { ok: true, value: v ?? viewOf(s)! };
    },
  };
}
