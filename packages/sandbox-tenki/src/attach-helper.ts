/**
 * In-process attach bridge for `agentbox shell|claude|codex|opencode -p tenki`.
 * The vercel provider drives an external CLI for the PTY hop and E2B opens an
 * SDK PTY; Tenki exposes `session.ssh()` — a PTY-backed shell channel over the
 * data plane — so we bridge the host PTY to it.
 *
 * Wire shape:
 *
 *   stdin (host PTY) ─► process.stdin ─► conn.write ─►  in-box shell (ssh PTY)
 *                                                              │
 *   stdout (host PTY) ◄── process.stdout ◄── conn.read ◄───────┘
 *
 * Argv: `node attach-helper.cjs --session-id <id> [--detached]`.
 * Env:
 *   TENKI_AUTH_TOKEN            Tenki credentials (threaded in by build-attach).
 *   AGENTBOX_TENKI_INNER_CMD    Inner bash command (renderInnerCommand output:
 *                               tmux ensure + attach). Passed via env so quoting
 *                               stays sane and it doesn't leak through `ps`.
 *   TENKI_BASE_URL,
 *   TENKI_GATEWAY_ADDRESS       Optional control-plane overrides.
 *   AGENTBOX_HOST_TERM          Host TERM, forwarded into the session.
 *
 * `--detached`: pre-start mode. The inner command only creates + configures the
 * tmux session (renderInnerCommand with `detached:true`, NO trailing `exec tmux
 * attach`). Opening the interactive channel here would idle at a prompt forever
 * (nothing to `exec` into), so the host's `runDetached` await would never
 * resolve and `agentbox <agent>` would hang after "box ready". In detached mode
 * we run the inner command once via the non-interactive `run` and exit.
 *
 * NOTE: `SSHConnection` exposes only read/write/close — no resize — so the
 * in-box PTY can't track host SIGWINCH. tmux renders at its default size; live
 * window-size propagation is a follow-up if/when the SDK exposes a resize op.
 */

import { TenkiSandbox } from '@tenkicloud/sandbox';
import { ensureTenkiEnvLoaded } from './env-loader.js';

interface ParsedArgs {
  sessionId: string;
  detached: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let sessionId: string | undefined;
  let detached = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') {
      sessionId = argv[i + 1];
      i++;
    } else if (a === '--detached') {
      detached = true;
    }
  }
  if (!sessionId) {
    process.stderr.write('attach-helper: --session-id is required\n');
    process.exit(2);
  }
  return { sessionId, detached };
}

function buildClient(): TenkiSandbox {
  const authToken = process.env.TENKI_AUTH_TOKEN;
  if (!authToken) {
    process.stderr.write('attach-helper: TENKI_AUTH_TOKEN env is required\n');
    process.exit(2);
  }
  const opts: ConstructorParameters<typeof TenkiSandbox>[0] = { authToken };
  if (process.env.TENKI_BASE_URL) opts.baseUrl = process.env.TENKI_BASE_URL;
  if (process.env.TENKI_GATEWAY_ADDRESS) opts.gatewayAddress = process.env.TENKI_GATEWAY_ADDRESS;
  return new TenkiSandbox(opts);
}

async function main(): Promise<void> {
  const { sessionId, detached } = parseArgs(process.argv.slice(2));
  ensureTenkiEnvLoaded();

  const inner = process.env.AGENTBOX_TENKI_INNER_CMD;
  if (!inner) {
    process.stderr.write('attach-helper: AGENTBOX_TENKI_INNER_CMD env is required\n');
    process.exit(2);
  }

  const client = buildClient();
  let session;
  try {
    session = await client.get(sessionId);
  } catch (err) {
    process.stderr.write(
      `attach-helper: could not resolve session ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Defensive: an attach right after resume should already be RUNNING, but
  // wake a paused box rather than failing the channel open.
  if (session.state !== 'RUNNING') {
    try {
      await session.resume();
      await session.waitReady(60_000);
    } catch {
      // fall through — the op below will surface a clear transport error
    }
  }

  // Detached pre-start: run the session-create command once and exit (no
  // interactive channel). See the file header for why opening ssh() here would
  // hang the caller.
  if (detached) {
    try {
      const r = await session.run(['bash', '-c', inner], { cwd: '/workspace' });
      process.exit(r.exitCode ?? 0);
    } catch (err) {
      process.stderr.write(
        `attach-helper: detached pre-start failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  // Interactive: open the SSH-backed shell channel and bridge it to the host PTY.
  let conn;
  try {
    conn = await session.ssh();
  } catch (err) {
    process.stderr.write(
      `attach-helper: could not open shell channel: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const cleanup = (): void => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdin.pause();
  };

  // Hand control to the inner command (tmux ensure + `exec tmux attach`); the
  // trailing newline triggers execution.
  await conn.write(new TextEncoder().encode(inner + '\n'));

  // Host stdin -> in-box shell.
  process.stdin.on('data', (chunk: Buffer) => {
    conn.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)).catch(() => {
      // channel gone (box died / user detached); the read loop below exits.
    });
  });
  // Forward Ctrl+C to the shell so tmux receives it rather than killing us.
  process.on('SIGINT', () => {
    conn.write(new Uint8Array([3])).catch(() => undefined);
  });

  let exitCode = 0;
  try {
    for (;;) {
      const data = await conn.read();
      if (data === null) break; // channel closed (tmux detach / box stop)
      process.stdout.write(data);
    }
  } catch (err) {
    process.stderr.write(
      `attach-helper: shell channel read failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitCode = 1;
  } finally {
    try {
      conn.close();
    } catch {
      // ignore
    }
    cleanup();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(
    `attach-helper: unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
