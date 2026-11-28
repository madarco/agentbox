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
  readAccountLoginRequest,
  readAccounts,
  resolveAgentSpec,
  takeAccountLoginCode,
  writeAccountLoginState,
  type AccountLoginWorkerState,
} from '@agentbox/sandbox-core';
import { captureVolumeLogin, dockerVolumeFileReader, ensureImage } from '@agentbox/sandbox-docker';
import { agentLoginSpec } from '../agents/command/login.js';
import { captureDefaultLogin, readDefaultVolumeLogin } from '../lib/login-fanout.js';
import { syncAgentCredentialsIfChanged } from './control-plane.js';

type StatePatch = Partial<Omit<AccountLoginWorkerState, 'updatedAt' | 'pid'>>;

/** Sign the account in and store it. Throws a message for the session's `error`. */
async function signInAndStore(
  a: AgentCliSpec,
  account: string,
  mode: 'add' | 'renew',
  setState: (patch: StatePatch) => void,
  sessionId: string,
  log: ReturnType<typeof openCommandLog>,
  signal: AbortSignal,
): Promise<StatePatch> {
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
  const volume = named
    ? accountConfigVolume(a.runtime.sharedVolume, account)
    : a.runtime.sharedVolume;
  await a.runtime.ensureVolume(
    { volume },
    { syncFromHost: true, image, ...(named ? { account } : {}) },
  );
  if (named && existing) await a.runtime.resetAccountVolume?.(volume, image);
  const before = named ? null : await readDefaultVolumeLogin(a.id, image);

  const binding = a.runtime.loginBinding({
    image,
    ...(named ? { volume } : {}),
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
    verify: binding.verify,
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

  if (named) {
    const cap = await captureVolumeLogin({
      spec: resolveAgentSpec(a.id),
      account: { id: account },
      read: dockerVolumeFileReader(volume, image),
      ...(a.runtime.accountIdentity ? { identity: a.runtime.accountIdentity } : {}),
    });
    log.write(`captured ${a.id}/${account} (written=${String(cap.written)}: ${cap.reason})`);
    if (!cap.written && cap.reason !== 'unchanged') {
      throw new Error(`the store kept its login (${cap.reason}); nothing was changed`);
    }
    return { ...(cap.identity ? { identity: cap.identity } : {}) };
  }
  if (!(await captureDefaultLogin(a.id, image, before))) {
    throw new Error('the sign-in left no new login in the volume');
  }
  // A control box's custody copy is stale now (no-op without one).
  await syncAgentCredentialsIfChanged().catch((err: unknown) =>
    log.write(`custody sync failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  return {};
}

export const accountLoginWorkerCommand = new Command('_account-login-worker')
  .description('internal: hold a hub-driven account sign-in (do not invoke directly)')
  .argument('<id>', 'session id (~/.agentbox/account-login/<id>/)')
  .action(async (id: string) => {
    const log = openCommandLog(`account-login-${id}`);
    log.write(`worker pid=${String(process.pid)} for session ${id}`);
    let cur: Omit<AccountLoginWorkerState, 'updatedAt'> = { phase: 'starting', pid: process.pid };
    const setState = (patch: StatePatch): void => {
      cur = { ...cur, ...patch, pid: process.pid };
      // A rejected code is shown once; the next phase change clears it.
      if (patch.lastError === undefined && 'phase' in patch) delete cur.lastError;
      writeAccountLoginState(id, cur);
    };
    setState({ phase: 'starting' });

    const abort = new AbortController();
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => {
        log.write(`received ${sig}; cancelling`);
        abort.abort();
      });
    }

    const req = readAccountLoginRequest(id);
    const a = req ? agentLoginSpec(req.agent) : undefined;
    let code = 1;
    try {
      if (!req) throw new Error('internal: the session has no request');
      if (!a) throw new Error(`${req.agent} has no sign-in`);
      const done = await signInAndStore(a, req.account, req.mode, setState, id, log, abort.signal);
      setState({ phase: 'signed-in', ...done });
      code = 0;
    } catch (err) {
      const message = abort.signal.aborted
        ? 'cancelled'
        : err instanceof Error
          ? err.message
          : String(err);
      log.write(`failed: ${message}`);
      setState({ phase: 'error', error: message });
    }
    log.close();
    process.exit(code);
  });
