/**
 * In-process attach bridge for `agentbox shell|claude|codex|opencode -p e2b`.
 * The vercel provider drives the external `sbx exec -i` CLI for the PTY hop;
 * E2B has no equivalent so we ship our own helper. The CLI spawns this script
 * as a child process attached to the user's terminal PTY, and we proxy
 * stdin/stdout/SIGWINCH to a PTY opened over the E2B SDK.
 *
 * Wire shape:
 *
 *   stdin (host PTY)                 ┌──── pty.sendInput ────►  in-box PTY
 *                                    │                            │
 *   process.stdin ──────► attach-helper.cjs (this file)            │
 *                                    │                            │
 *   stdout (host PTY) ◄── onData ────┴──────────────────  ◄────────┘
 *
 * Argv: `node attach-helper.cjs --sandbox-id <id> [--user <name>] [--detached]`.
 * Env:
 *   E2B_API_KEY                E2B credentials (resolved via the credentials
 *                              loader; the spawning CLI threads it in).
 *   AGENTBOX_E2B_INNER_CMD     Inner bash command (renderInnerCommand output:
 *                              the tmux ensure + attach). Passed via env, not
 *                              argv, so quoting stays sane and it doesn't leak
 *                              through `ps`.
 *   E2B_DOMAIN, DEBUG          Plumbed to the SDK if set; otherwise default.
 *
 * Exit code mirrors the inner command (the tmux session). Detach
 * (`Ctrl+a d`) collapses tmux → the PTY exits 0; an SDK transport error
 * exits 1 so the CLI's reconnect loop fires.
 *
 * `--detached`: pre-start mode. The inner command only creates + configures the
 * tmux session (renderInnerCommand with `detached:true`, i.e. NO trailing
 * `exec tmux attach`). Unlike the SSH/Vercel transports — where the detached
 * argv runs the inner command as the remote process and EXITS — this helper's
 * interactive path opens a persistent in-box PTY shell that, with nothing to
 * `exec` into, idles at a prompt forever (the PTY never exits, so the host
 * `runDetached` await never resolves and `agentbox <agent>` hangs after "box
 * ready"). So in detached mode we skip the PTY entirely: run the inner command
 * once via the non-interactive `commands.run` and exit with its code.
 */

import { Sandbox } from 'e2b';
import { ensureE2bEnvLoaded } from './env-loader.js';

interface ParsedArgs {
  sandboxId: string;
  user: string;
  detached: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let sandboxId: string | undefined;
  let user = 'vscode';
  let detached = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sandbox-id') {
      sandboxId = argv[i + 1];
      i++;
    } else if (a === '--user') {
      user = argv[i + 1] ?? user;
      i++;
    } else if (a === '--detached') {
      detached = true;
    }
  }
  if (!sandboxId) {
    process.stderr.write('attach-helper: --sandbox-id is required\n');
    process.exit(2);
  }
  return { sandboxId, user, detached };
}

async function main(): Promise<void> {
  const { sandboxId, user, detached } = parseArgs(process.argv.slice(2));
  ensureE2bEnvLoaded();

  const inner = process.env.AGENTBOX_E2B_INNER_CMD;
  if (!inner) {
    process.stderr.write('attach-helper: AGENTBOX_E2B_INNER_CMD env is required\n');
    process.exit(2);
  }
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    process.stderr.write('attach-helper: E2B_API_KEY env is required\n');
    process.exit(2);
  }

  // connect() auto-resumes a paused sandbox; correct for an interactive
  // attach (the user just asked to open a shell on it). Timeout extended so a
  // long shell session doesn't get reaped after 5 minutes.
  let sb;
  try {
    sb = await Sandbox.connect(sandboxId, { apiKey, timeoutMs: 55 * 60_000 });
  } catch (err) {
    process.stderr.write(
      `attach-helper: could not connect to sandbox ${sandboxId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Detached pre-start: just run the session-create command once and exit (no
  // PTY, no stdin wiring). Opening the interactive PTY here would idle forever
  // because the detached inner has no `exec tmux attach` to take over the
  // shell — see the file header. `commands.run` mirrors the backend's exec.
  if (detached) {
    try {
      const r = await sb.commands.run(inner, {
        user: user as 'root' | 'user',
        cwd: '/workspace',
        timeoutMs: 5 * 60_000,
      });
      process.exit(r.exitCode ?? 0);
    } catch (err) {
      // commands.run throws on non-zero exit; surface the code so a real
      // session-create failure isn't masked, but never hang.
      const code = (err as { exitCode?: number }).exitCode;
      if (typeof code === 'number') process.exit(code);
      process.stderr.write(
        `attach-helper: detached pre-start failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  // Default to 80x24 if stdout isn't a TTY (e.g. piped). The PTY API requires
  // positive dimensions; node-pty hosts always set them.
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;

  // Forwards `process.stdin` raw to the in-box PTY. node-pty already sets the
  // host PTY to raw; `setRawMode` here is defensive for the spawnSync fallback.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const handle = await sb.pty.create({
    cols,
    rows,
    user: user as 'root' | 'user',
    cwd: '/workspace',
    envs: {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      // Forwarded from the host by build-attach.ts. The inner command's TERM
      // guard (renderInnerCommand) downgrades to xterm-256color when the box's
      // terminfo lacks it, so an exotic host TERM never breaks the attach.
      TERM: process.env.AGENTBOX_HOST_TERM || 'xterm-256color',
    },
    // Long-lived. We don't want the SDK reaping the PTY mid-session.
    timeoutMs: 55 * 60_000,
    onData: (data: Uint8Array) => {
      process.stdout.write(data);
    },
  });

  const pid = handle.pid;

  // Kick off the inner command. The PTY is a default shell for `user`; sending
  // the inner command (renderInnerCommand: tmux ensure + `exec tmux attach`)
  // hands control to tmux. The trailing newline triggers execution.
  await sb.pty.sendInput(pid, new TextEncoder().encode(inner + '\n'));

  // Stdin → in-box PTY.
  process.stdin.on('data', (chunk: Buffer) => {
    sb.pty
      .sendInput(pid, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      .catch(() => {
        // The PTY is gone (sandbox died, user detached). The wait() below
        // resolves and we exit cleanly.
      });
  });

  // SIGWINCH / Node's `resize` event → in-box PTY resize.
  const onResize = (): void => {
    const c = process.stdout.columns ?? cols;
    const r = process.stdout.rows ?? rows;
    if (c > 0 && r > 0) {
      sb.pty.resize(pid, { cols: c, rows: r }).catch(() => {
        // ignore — race with shutdown
      });
    }
  };
  process.stdout.on('resize', onResize);

  // Best-effort tidy up if the helper is killed by the parent. The PTY's
  // server-side cleanup also fires when the SDK transport drops.
  const cleanup = (): void => {
    process.stdout.off('resize', onResize);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdin.pause();
  };
  process.on('SIGINT', () => {
    // forward Ctrl+C to the PTY; the user expects tmux to receive it.
    sb.pty.sendInput(pid, new Uint8Array([3])).catch(() => undefined);
  });

  let exitCode = 0;
  try {
    const result = await handle.wait();
    exitCode = result.exitCode ?? 0;
  } catch (err) {
    // Transport error or PTY kill — surface a non-zero so the CLI's
    // reconnect loop can fire.
    process.stderr.write(
      `attach-helper: PTY wait failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitCode = 1;
  } finally {
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
