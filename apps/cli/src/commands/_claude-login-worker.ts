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
import { openCommandLog } from '../lib/log-file.js';
import { runClaudeLogin } from '../lib/claude-login-run.js';
import {
  readLoginRequest,
  takeLoginCode,
  writeLoginState,
  type LoginState,
} from '../lib/claude-login-session.js';

export const claudeLoginWorkerCommand = new Command('_claude-login-worker')
  .description('internal: drive `claude auth login` under a pty for headless login (do not invoke directly)')
  .argument('<id>', 'login session id (~/.agentbox/claude-login/<id>/)')
  .action(async (id: string) => {
    const log = openCommandLog(`claude-login-${id}`);
    log.write(`worker pid=${String(process.pid)} starting for session ${id}`);

    const base = { pid: process.pid, createdAt: new Date().toISOString() };
    let cur: Omit<LoginState, 'updatedAt'> = { ...base, phase: 'starting' };
    const setState = (patch: Partial<Omit<LoginState, 'updatedAt' | 'pid' | 'createdAt'>>): void => {
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

    const result = await runClaudeLogin({
      image: req.image,
      // No method flags → the subscription paste-code flow (prints a URL, reads a
      // code). Respect an explicit method the user forwarded (e.g. --console).
      extraArgs: req.extraArgs,
      writeRaw: (chunk) => log.raw(chunk),
      writeLog: (line) => log.write(line),
      onPhase: (phase, update) => setState({ phase, ...update }),
      getCode: () => takeLoginCode(id),
      signal: abort.signal,
    });

    log.close();
    process.exit(result.ok ? 0 : 1);
  });
