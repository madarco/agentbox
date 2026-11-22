/**
 * Internal worker for the headless `agentbox claude login` flow. Hidden from
 * `--help`. The foreground `agentbox claude login` (non-TTY or `--headless`)
 * spawns this detached; it holds the single live `claude auth login` process —
 * required because the PKCE verifier that mints the auth URL must also exchange
 * the pasted code, so the URL-printer and the code-exchanger have to be one
 * process. It drives that process (via the shared `runClaudeLogin` core),
 * publishes the auth URL into the session's `state.json`, waits for the `--code`
 * call to drop a `code` file, feeds it in, and on success runs the warm-up +
 * host-backup sync. See lib/claude-login-session.ts for the IPC contract.
 */
import { Command } from 'commander';
import { openCommandLog } from '@agentbox/cli-kit';
import {
  claudeAccountIdentity,
  claudeAccountVolume,
  runClaudeLogin,
} from '@agentbox/agent-claude/cli';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { captureVolumeLogin, dockerVolumeFileReader } from '@agentbox/sandbox-docker';
import { syncAgentCredentialsIfChanged } from './control-plane.js';
import {
  readLoginRequest,
  takeLoginCode,
  writeLoginState,
  type LoginState,
} from '@agentbox/agent-claude/cli';

export const claudeLoginWorkerCommand = new Command('_claude-login-worker')
  .description(
    'internal: drive `claude auth login` under a pty for headless login (do not invoke directly)',
  )
  .argument('<id>', 'login session id (~/.agentbox/claude-login/<id>/)')
  .action(async (id: string) => {
    const log = openCommandLog(`claude-login-${id}`);
    log.write(`worker pid=${String(process.pid)} starting for session ${id}`);

    const base = { pid: process.pid, createdAt: new Date().toISOString() };
    let cur: Omit<LoginState, 'updatedAt'> = { ...base, phase: 'starting' };
    const setState = (
      patch: Partial<Omit<LoginState, 'updatedAt' | 'pid' | 'createdAt'>>,
    ): void => {
      cur = { ...cur, ...patch };
      writeLoginState(id, cur);
    };
    setState({ phase: 'starting' });

    const req = readLoginRequest(id);
    if (!req) {
      log.write(`FATAL: no request.json for session ${id}`);
      setState({ phase: 'error', error: 'internal: missing login request' });
      log.close();
      process.exit(64);
    }

    // SIGTERM/SIGINT → abort the login cleanly (the core sets phase:error).
    const abort = new AbortController();
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => {
        log.write(`received ${sig}; aborting`);
        abort.abort();
      });
    }

    // A named account signs in against its own volume (prepared by the
    // foreground call) and is captured into the account store, never the
    // legacy backup.
    const volume = req.account ? claudeAccountVolume(req.account) : undefined;
    const held: { done?: Partial<Omit<LoginState, 'updatedAt' | 'pid' | 'createdAt'>> } = {};
    const result = await runClaudeLogin({
      image: req.image,
      ...(volume ? { volume } : {}),
      // No method flags → the subscription paste-code flow (prints a URL, reads a
      // code). Respect an explicit method the user forwarded (e.g. --console).
      extraArgs: req.extraArgs,
      writeRaw: (chunk) => log.raw(chunk),
      writeLog: (line) => log.write(line),
      // A named account is not done until it is captured: hold `done` back so
      // the waiting `--code` call cannot report success before the store has it.
      onPhase: (phase, update) => {
        if (phase === 'done' && req.account) {
          held.done = update ?? {};
          return;
        }
        setState({ phase, ...update });
      },
      getCode: () => takeLoginCode(id),
      signal: abort.signal,
    });

    // Headless counterpart of the foreground `claude login` re-push: a fresh
    // login makes the control box's copy stale, so refresh custody from the
    // just-synced host backup (best-effort, silent, no-op without a control box).
    if (result.ok && req.account && volume) {
      try {
        const res = await captureVolumeLogin({
          spec: resolveAgentSpec('claude'),
          account: req.account,
          read: dockerVolumeFileReader(volume, req.image),
          identity: claudeAccountIdentity,
        });
        log.write(`captured account '${req.account.id}' (written=${String(res.written)}: ${res.reason})`);
        setState({ ...held.done, phase: 'done' });
      } catch (err) {
        log.write(`account capture failed: ${(err as Error).message}`);
        setState({ phase: 'error', error: `could not store the account: ${(err as Error).message}` });
        log.close();
        process.exit(1);
      }
    } else if (result.ok) {
      await syncAgentCredentialsIfChanged();
    }

    log.close();
    process.exit(result.ok ? 0 : 1);
  });
