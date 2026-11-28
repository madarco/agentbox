/**
 * Internal worker for a hub-driven sign-in (docs/credentials-tui-plan.md,
 * Phase 2). The hub's `POST /api/v1/accounts/:agent/:id/login` writes the
 * session's `request.json` and spawns this detached; it holds the agent's live
 * login (PKCE: the URL-printer must be the code-exchanger) and reports through
 * the session files (`@agentbox/sandbox-core` account-login-session).
 *
 * Agent-neutral: everything agent-specific comes from the agent's runtime
 * (`loginBinding`, `ensureVolume`, `accountIdentity`). On success the login is
 * stored (a named account's secret, or the default login's backup) and the
 * worker ends at `signed-in`; the hub then fans it out to the account's boxes.
 */
import { homedir } from 'node:os';
import { Command } from 'commander';
import { loadEffectiveConfig } from '@agentbox/config';
import { accountConfigVolume, findAccount, isDefaultAccount } from '@agentbox/core';
import { openCommandLog, runAgentLogin, type AgentCliSpec } from '@agentbox/cli-kit';
import {
  isAccountLoginCancelled,
  readAccountLoginRequest,
  sameLoginIdentity,
  type AccountLoginIdentity,
  type AccountLoginRequest,
  readAccounts,
  resolveAgentSpec,
  takeAccountLoginCode,
  writeAccountLoginState,
  type AccountLoginWorkerState,
} from '@agentbox/sandbox-core';
import { captureVolumeLogin, dockerVolumeFileReader, ensureImage } from '@agentbox/sandbox-docker';
import { agentLoginSpec } from '../agents/command/login.js';
import { removeDockerVolume, storeDefaultLogin } from '../lib/login-fanout.js';
import { syncAgentCredentialsIfChanged } from './control-plane.js';

type StatePatch = Partial<Omit<AccountLoginWorkerState, 'updatedAt' | 'pid'>>;

/** The browser signed in another identity than the account holds. */
class IdentityMismatchError extends Error {
  constructor(
    readonly account: string,
    readonly mismatch: NonNullable<AccountLoginWorkerState['mismatch']>,
  ) {
    const who = (i: AccountLoginIdentity): string => i.email ?? i.org ?? 'another account';
    super(
      `this signed in ${who(mismatch.signedIn)}, but ${account} is ${who(mismatch.stored)}; nothing was changed (start again with replace to store it anyway)`,
    );
  }
}

interface WorkerContext {
  setState: (patch: StatePatch) => void;
  sessionId: string;
  log: ReturnType<typeof openCommandLog>;
  signal: AbortSignal;
  /** Set while a cancel must wait: a code is being exchanged, or the login is being stored. */
  committing: { value: boolean };
  /** The scratch volume the sign-in runs in, removed when the worker ends. */
  scratch: { value: string | null };
}

/** Sign the account in and store it. Throws a message for the session's `error`. */
async function signInAndStore(
  a: AgentCliSpec,
  req: AccountLoginRequest,
  ctx: WorkerContext,
): Promise<StatePatch> {
  const { account, mode } = req;
  const { setState, sessionId, log, signal } = ctx;
  const named = !isDefaultAccount(account);
  if (named && a.runtime.supportsAccountLogin !== true) {
    // A runtime that ignores the volume would sign the owner's shared login in
    // and store it under the new name.
    throw new Error(`${a.shortName} cannot sign in a named login account`);
  }
  const existing = findAccount(await readAccounts(), a.id, account);
  if (existing && existing.kind !== 'login') {
    throw new Error(`${a.id}/${account} is a ${existing.kind}, not a login`);
  }
  if (mode === 'add' && existing) throw new Error(`${a.id}/${account} already exists`);

  // The hub's own machine config: the hub's cwd is no project of the user's.
  const cfg = await loadEffectiveConfig(homedir());
  log.write('preparing the sign-in image');
  const { ref: image } = await ensureImage(cfg.effective.box.image, {
    agents: [a.id],
    onProgress: (line) => log.write(line),
  });
  // The account's own volume, which its docker boxes mount live, is not
  // touched until the new login passed the identity check: the sign-in runs in
  // a scratch volume seeded like the account's (host config, no host login, no
  // account state) and only the checked login is stored from it.
  const target = named
    ? accountConfigVolume(a.runtime.sharedVolume, account)
    : a.runtime.sharedVolume;
  const volume = `${target}-signin-${sessionId}`;
  ctx.scratch.value = volume;
  await a.runtime.ensureVolume({ volume }, { syncFromHost: true, image, account });
  await a.runtime.resetAccountVolume?.(volume, image);
  const stored = existing?.identity;
  const checked = stored !== undefined && req.replace !== true;

  const binding = a.runtime.loginBinding({
    image,
    volume,
    writeLog: (line) => log.write(line),
  });
  // The pty echoes what is typed, so the raw stream would log the code. Once
  // a code is sent, hold the stream back and write it with every code sent so
  // far masked, at the next phase change (an echo split over chunks included).
  const sent: string[] = [];
  let held: string | null = null;
  const flush = (): void => {
    if (held === null) return;
    let text = held;
    for (const c of sent) text = text.split(c).join('[redacted]');
    log.raw(text);
    held = null;
  };
  // Who the browser signed in, read from the scratch volume before anything
  // is stored: a renew that picked another account in the browser must not
  // re-identify this one.
  const readIdentity = async (): Promise<AccountLoginIdentity | undefined> => {
    const reader = a.runtime.accountIdentity;
    if (!reader) return undefined;
    const read = dockerVolumeFileReader(volume, image);
    const files: Record<string, string | null> = {};
    for (const rel of reader.files) files[rel] = await read(rel);
    return reader.parse(files);
  };
  const res = await runAgentLogin({
    spec: binding.spec,
    dockerArgv: binding.dockerArgv,
    writeRaw: (chunk) => {
      if (held === null) log.raw(chunk);
      else held += chunk;
    },
    writeLog: (line) => log.write(line),
    onPhase: (phase, u) => {
      if (phase !== 'exchanging') flush();
      // From the login's exit (verify) on, a cancel waits; a refused code
      // brings the sign-in back to a cancellable phase.
      if (phase !== 'done' && phase !== 'error') ctx.committing.value = phase === 'exchanging';
      // `done` is not ours to report yet: the login is not stored.
      if (phase === 'done' || phase === 'error') return;
      if (phase === 'starting' || phase === 'exchanging') {
        setState({ phase });
        return;
      }
      const need = u?.need;
      setState({
        phase,
        ...(u?.url ? { url: u.url } : {}),
        ...(u?.userCode ? { userCode: u.userCode } : {}),
        ...(phase === 'awaiting-code'
          ? {
              input:
                need?.kind === 'secret'
                  ? { kind: 'secret' as const, label: need.label }
                  : { kind: 'code' as const },
            }
          : {}),
        ...(u?.lastError ? { lastError: u.lastError } : {}),
      });
    },
    getInput: () => {
      const code = takeAccountLoginCode(sessionId);
      if (code) {
        sent.push(code);
        held ??= '';
      }
      return code;
    },
    verify: () => {
      // The login process exited: what it wrote must be stored or undone.
      ctx.committing.value = true;
      return binding.verify();
    },
    // Claude writes who signed in (`oauthAccount`) on this warm-up turn, so
    // the identity is read after it.
    ...(binding.finalize ? { finalize: binding.finalize } : {}),
    signal,
  });
  flush();
  if (!res.ok) {
    // The core's error quotes the last lines of the stream, the echo included.
    let error = res.unsupported ?? res.error ?? 'sign-in failed';
    for (const c of sent) error = error.split(c).join('[redacted]');
    throw new Error(error);
  }
  if (checked) {
    // Fail closed: a renew stores only a login it can tell is the account's.
    let signedIn: AccountLoginIdentity | undefined;
    try {
      signedIn = await readIdentity();
    } catch (err) {
      throw new Error(
        `could not tell who signed in (${err instanceof Error ? err.message : String(err)}); nothing was changed (start again with replace to store it anyway)`,
      );
    }
    if (!signedIn?.email && !signedIn?.org) {
      throw new Error(
        'could not tell who signed in (no email or org in the new login); nothing was changed (start again with replace to store it anyway)',
      );
    }
    if (!sameLoginIdentity(stored, signedIn)) {
      throw new IdentityMismatchError(`${a.id}/${account}`, { stored: stored!, signedIn });
    }
  }

  const read = dockerVolumeFileReader(volume, image);
  if (named) {
    const cap = await captureVolumeLogin({
      spec: resolveAgentSpec(a.id),
      account: { id: account },
      read,
      ...(a.runtime.accountIdentity ? { identity: a.runtime.accountIdentity } : {}),
    });
    log.write(`captured ${a.id}/${account} (written=${String(cap.written)}: ${cap.reason})`);
    if (!cap.written && cap.reason !== 'unchanged') {
      throw new Error(`the store kept its login (${cap.reason}); nothing was changed`);
    }
    // Another identity replaced the account's: the volume's cached profile
    // is the old one's (claude rewrites it on the next turn).
    if (req.replace === true) await a.runtime.resetAccountVolume?.(target, image);
    return { ...(cap.identity ? { identity: cap.identity } : {}) };
  }
  const credRel = resolveAgentSpec(a.id).credential?.boxRelPath;
  const content = credRel ? await read(credRel) : null;
  if (content === null || !(await storeDefaultLogin(a.id, image, content))) {
    throw new Error('the sign-in left no new login');
  }
  if (req.replace === true) await a.runtime.resetAccountVolume?.(target, image);
  // A control box's custody copy is stale now (no-op without one).
  await syncAgentCredentialsIfChanged().catch((err: unknown) =>
    log.write(`custody sync failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  const identity = a.runtime.accountIdentity
    ? await readIdentity().catch(() => undefined)
    : undefined;
  return identity ? { identity } : {};
}

export const accountLoginWorkerCommand = new Command('_account-login-worker')
  .description('internal: hold a hub-driven account sign-in (do not invoke directly)')
  .argument('<id>', 'session id (~/.agentbox/account-login/<id>/)')
  .action(async (id: string) => {
    const log = openCommandLog(`account-login-${id}`);
    log.write(`worker pid=${String(process.pid)} for session ${id}`);
    const committing = { value: false };
    const scratch: { value: string | null } = { value: null };
    /** Set once the worker is wrapping up, so a cancel's forced exit does not cut it short. */
    let ending = false;
    const dropScratch = async (): Promise<void> => {
      if (!scratch.value) return;
      const removed = await removeDockerVolume(scratch.value).catch(() => false);
      if (!removed) log.write(`could not remove the scratch volume ${scratch.value}`);
    };
    let cancelWaiting: string | null = null;
    let cur: Omit<AccountLoginWorkerState, 'updatedAt'> = { phase: 'starting', pid: process.pid };
    const setState = (patch: StatePatch): void => {
      cur = { ...cur, ...patch, pid: process.pid };
      if (cancelWaiting !== null && patch.phase?.startsWith('awaiting')) {
        queueMicrotask(() => cancel(cancelWaiting!));
      }
      // A rejected code is shown once; the next phase change clears it.
      if (patch.lastError === undefined && 'phase' in patch) delete cur.lastError;
      writeAccountLoginState(id, cur);
    };
    setState({ phase: 'starting' });

    const abort = new AbortController();
    const cancel = (why: string): void => {
      if (abort.signal.aborted) return;
      if (committing.value) {
        // A code in exchange or a login being stored finishes (and is fanned
        // out); a refused code brings the sign-in back to a cancellable phase.
        if (cancelWaiting === null) log.write(`${why}; finishing the sign-in first`);
        cancelWaiting = why;
        return;
      }
      log.write(`${why}; cancelling`);
      abort.abort();
      // The login itself ends on the abort at once. The image build and the
      // volume prep before it do not see it: end the process instead.
      setTimeout(() => {
        if (ending) return;
        ending = true;
        setState({ phase: 'error', error: 'cancelled' });
        void dropScratch().finally(() => {
          log.close();
          process.exit(1);
        });
      }, 3_000).unref();
    };
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => cancel(`received ${sig}`));
    }
    // The hub's cancel before this worker had a pid to signal.
    const cancelPoll = setInterval(() => {
      if (isAccountLoginCancelled(id)) cancel('cancel requested');
    }, 1_000);
    cancelPoll.unref();

    const req = readAccountLoginRequest(id);
    const a = req ? agentLoginSpec(req.agent) : undefined;
    let code = 1;
    try {
      if (!req) throw new Error('internal: the session has no request');
      if (!a) throw new Error(`${req.agent} has no sign-in`);
      const done = await signInAndStore(a, req, {
        setState,
        sessionId: id,
        log,
        signal: abort.signal,
        committing,
        scratch,
      });
      setState({ phase: 'signed-in', ...done });
      code = 0;
    } catch (err) {
      const message = abort.signal.aborted
        ? 'cancelled'
        : err instanceof Error
          ? err.message
          : String(err);
      log.write(`failed: ${message}`);
      setState({
        phase: 'error',
        error: message,
        ...(err instanceof IdentityMismatchError ? { mismatch: err.mismatch } : {}),
      });
    }
    if (!ending) {
      ending = true;
      await dropScratch();
      log.close();
      process.exit(code);
    }
  });
