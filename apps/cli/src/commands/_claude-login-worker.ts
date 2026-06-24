/**
 * Internal worker for the headless `agentbox claude login` flow. Hidden from
 * `--help`. The foreground `agentbox claude login` (non-TTY or `--headless`)
 * spawns this detached; it holds the single live `claude auth login` process —
 * required because the PKCE verifier that mints the auth URL must also exchange
 * the pasted code, so the URL-printer and the code-exchanger have to be one
 * process. It drives that process under a node-pty, publishes the auth URL into
 * the session's `state.json`, waits for the `--code` call to drop a `code`
 * file, feeds it in, and on success runs the same warm-up + host-backup sync the
 * interactive login does. See lib/claude-login-session.ts for the IPC contract.
 */
import { Command } from 'commander';
import {
  buildClaudeLoginRunArgv,
  SHARED_CLAUDE_VOLUME,
  syncClaudeCredentials,
  volumeClaudeCredentials,
  warmUpClaudeCredentials,
} from '@agentbox/sandbox-docker';
import { openCommandLog } from '../lib/log-file.js';
import { loadPtyBackend } from '../pty/pty-backend.js';
import {
  extractOAuthUrl,
  readLoginRequest,
  takeLoginCode,
  writeLoginState,
  type LoginState,
} from '../lib/claude-login-session.js';

const URL_TIMEOUT_MS = 60_000;
const CODE_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 500;
// After a code is submitted, a line that looks like a rejection means claude
// re-prompted rather than exited — so we drop back to awaiting-code and let the
// user retry against the same (still-valid) PKCE verifier.
const INVALID_CODE = /invalid|incorrect|not a valid|try again|expired|rejected/i;
const BUF_CAP = 64 * 1024;

/** Last meaningful line of buffered output, stripped of escapes and clamped. */
function tailOf(buf: string): string {
  const clean = buf
    .replace(new RegExp('\\u001b\\[[0-9;?]*[ -\\/]*[@-~]', 'g'), '')
    .replace(/\r/g, '');
  const lines = clean.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-2).join(' ');
  return tail.length > 240 ? tail.slice(-240) : tail;
}

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

    const req = readLoginRequest(id);
    if (!req) {
      log.write(`FATAL: no request.json for session ${id}`);
      setState({ phase: 'error', error: 'internal: missing login request' });
      log.close();
      process.exit(64);
    }

    const backend = await loadPtyBackend();
    if (!backend) {
      log.write('FATAL: node-pty backend unavailable');
      setState({ phase: 'error', error: 'pty-unavailable: the node-pty prebuild is not installed' });
      log.close();
      process.exit(1);
    }

    // No method flags → default to the subscription paste-code flow (the one
    // that prints a URL and reads a single code line). Respect an explicit
    // method the user forwarded (e.g. --console / --sso).
    const methodArgs = req.extraArgs.length > 0 ? req.extraArgs : ['--claudeai'];
    const dockerArgv = buildClaudeLoginRunArgv({
      volume: SHARED_CLAUDE_VOLUME,
      image: req.image,
      extraArgs: methodArgs,
    });
    log.write(`spawning: docker ${dockerArgv.join(' ')}`);

    let buf = '';
    let urlPublished = false;
    let lastError: string | undefined;
    let finished = false;
    const disposers: Array<() => void> = [];

    const pty = backend.ptySpawn('docker', dockerArgv, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      env: process.env,
    });

    const cleanExit = (code: number): void => {
      finished = true;
      for (const d of disposers) d();
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
      log.close();
      process.exit(code);
    };

    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => {
        if (finished) return;
        log.write(`received ${sig}; aborting`);
        setState({ phase: 'error', error: `login worker terminated (${sig})` });
        cleanExit(1);
      });
    }

    // Poll for the code file; only consume one while we're actually waiting for it.
    const codePoll = setInterval(() => {
      if (finished || cur.phase !== 'awaiting-code') return;
      const code = takeLoginCode(id);
      if (code) {
        log.write('received code; submitting to login');
        setState({ phase: 'exchanging' });
        pty.write(code + '\r');
      }
    }, POLL_MS);
    disposers.push(() => clearInterval(codePoll));

    pty.onData((d: string) => {
      buf += d;
      if (buf.length > BUF_CAP) buf = buf.slice(-BUF_CAP);
      log.raw(d);
      if (!urlPublished) {
        const url = extractOAuthUrl(buf);
        if (url) {
          // Leave the no-URL guard timer to expire harmlessly; its callback
          // re-checks `urlPublished` and bails.
          urlPublished = true;
          log.write(`published auth url: ${url}`);
          setState({ phase: 'awaiting-code', url });
        }
        return;
      }
      if (cur.phase === 'exchanging' && INVALID_CODE.test(d)) {
        lastError = 'the code was not accepted — paste a fresh one';
        log.write('code rejected; back to awaiting-code');
        setState({ phase: 'awaiting-code', lastError });
      }
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (finished) return;
      log.write(`login process exited code=${String(exitCode)}`);
      void (async () => {
        let creds = { present: false, hasRefreshToken: false };
        try {
          creds = await volumeClaudeCredentials(SHARED_CLAUDE_VOLUME, req.image);
        } catch {
          /* treat as no-creds */
        }
        if (exitCode === 0 && creds.hasRefreshToken) {
          const warm = await warmUpClaudeCredentials(SHARED_CLAUDE_VOLUME, req.image, {
            onProgress: (l) => log.write(l),
          });
          await syncClaudeCredentials(
            { volume: SHARED_CLAUDE_VOLUME },
            { image: req.image, isolate: false },
          );
          setState({ phase: 'done', warmed: warm.warmed });
          cleanExit(0);
          return;
        }
        const tail = tailOf(buf);
        let error =
          exitCode === 0
            ? 'login exited without writing credentials'
            : `login exited with code ${String(exitCode)}`;
        if (lastError) error = lastError;
        if (tail) error += ` — ${tail}`;
        setState({ phase: 'error', error, exitCode });
        cleanExit(1);
      })();
    });

    const urlTimer = setTimeout(() => {
      if (urlPublished || finished) return;
      log.write('no auth URL within timeout');
      setState({ phase: 'error', error: 'login never printed an auth URL (see the worker log)' });
      cleanExit(1);
    }, URL_TIMEOUT_MS);
    disposers.push(() => clearTimeout(urlTimer));

    const codeTimer = setTimeout(() => {
      // Only abort while we're still WAITING for a code. Never kill an in-flight
      // exchange (`exchanging`) — a code submitted near the deadline, or a slow
      // token-exchange + credential warm-up, must be allowed to finish.
      if (finished || (cur.phase !== 'starting' && cur.phase !== 'awaiting-code')) return;
      log.write('no code within timeout; aborting');
      setState({ phase: 'error', error: 'timed out waiting for a code (10 min) — run login again' });
      cleanExit(1);
    }, CODE_TIMEOUT_MS);
    disposers.push(() => clearTimeout(codeTimer));
  });
