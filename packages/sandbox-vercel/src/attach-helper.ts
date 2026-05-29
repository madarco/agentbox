/**
 * Standalone host-side process that bridges the local terminal to a tmux
 * session inside a Vercel sandbox. The Vercel provider's `buildAttach` returns
 * an argv that spawns this file; `runWrappedAttach` runs it inside the host PTY
 * wrapper exactly like it runs `ssh -t '<tmux attach>'` for the SSH providers.
 *
 * Why a custom bridge: `@vercel/sandbox` (2.0.1) has no SSH and no stdin/PTY
 * channel on `runCommand` — output can be streamed out, but there is no
 * documented way to pipe keystrokes in. The portable mechanism that needs no
 * SSH, no extra exposed port, and no native deps is to drive tmux directly:
 *   - input:  forward local stdin to `tmux send-keys -H <hex>` (byte-exact),
 *   - output: poll `tmux capture-pane -p -e` and repaint the local screen.
 * It's higher-latency than a true PTY stream; the production upgrade (a
 * ttyd/WebSocket terminal over `sandbox.domain(port)`) is tracked in
 * docs/vercel-backlog.md.
 *
 * Invoked as:
 *   node attach-helper.js <sandboxId> <base64-json-spec>
 * where the JSON spec is { sessionName, command, kind, detached }.
 */

import { ensureFreshCredentials, resolveCredentials, Sandbox, type SandboxType } from './sdk.js';

interface AttachHelperSpec {
  sessionName: string;
  /** Inner command tmux runs when creating the session fresh. */
  command: string;
  kind: 'shell' | 'agent' | 'logs';
  /** When true: just ensure the session exists, then exit (pre-start path). */
  detached?: boolean;
}

const POLL_INTERVAL_MS = 120;
/** Ctrl-] detaches the local view (tmux's own Ctrl-b/Ctrl-a stay in-session). */
const DETACH_BYTE = 0x1d;

function sh(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Run a command in the box as the `vscode` box user; return stdout. */
async function boxRun(sb: SandboxType, cmd: string): Promise<{ exitCode: number; stdout: string }> {
  const r = await sb.runCommand({
    cmd: 'bash',
    args: ['-lc', `sudo -u vscode -H bash -lc ${sh(cmd)}`],
    sudo: true,
  });
  return { exitCode: r.exitCode, stdout: await r.stdout() };
}

async function ensureSession(sb: SandboxType, spec: AttachHelperSpec): Promise<void> {
  const s = sh(spec.sessionName);
  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;
  // has-session || new-session -d, started in /workspace so agents see it as cwd.
  const ensure =
    `tmux has-session -t ${s} 2>/dev/null || ` +
    `tmux new-session -d -s ${s} -x ${String(cols)} -y ${String(rows)} -c /workspace ${sh(spec.command)}`;
  const r = await boxRun(sb, ensure);
  if (r.exitCode !== 0) {
    throw new Error(`vercel attach: failed to ensure tmux session '${spec.sessionName}'`);
  }
}

async function resizeSession(sb: SandboxType, sessionName: string): Promise<void> {
  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;
  await boxRun(
    sb,
    `tmux resize-window -t ${sh(sessionName)} -x ${String(cols)} -y ${String(rows)} 2>/dev/null || true`,
  );
}

async function runInteractive(sb: SandboxType, spec: AttachHelperSpec): Promise<number> {
  await ensureSession(sb, spec);
  await resizeSession(sb, spec.sessionName);

  const stdin = process.stdin;
  const isTty = stdin.isTTY === true;
  if (isTty) stdin.setRawMode(true);
  stdin.resume();
  // Alternate screen + clear so we don't clobber the user's scrollback.
  process.stdout.write('\x1b[?1049h\x1b[H\x1b[2J');

  let stopped = false;
  let last = '';

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (isTty) {
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    stdin.pause();
    process.stdout.write('\x1b[?1049l'); // leave alternate screen
    process.removeListener('SIGWINCH', onResize);
  };

  const onResize = (): void => {
    void resizeSession(sb, spec.sessionName);
  };
  process.on('SIGWINCH', onResize);

  // Input pump: forward each stdin chunk to tmux as hex-encoded keys (byte
  // exact). Ctrl-] detaches the local view without killing the session.
  stdin.on('data', (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === DETACH_BYTE) {
      cleanup();
      return;
    }
    const hex = chunk.toString('hex').match(/.{2}/g);
    if (!hex || hex.length === 0) return;
    const keys = hex.map((h) => `0x${h}`).join(' ');
    void boxRun(sb, `tmux send-keys -t ${sh(spec.sessionName)} -H ${keys}`).catch(() => {
      // a dropped keystroke is recoverable; don't crash the attach
    });
  });

  // Output pump: poll the rendered pane and repaint on change.
  const timer = setInterval(() => {
    if (stopped) return;
    void boxRun(sb, `tmux capture-pane -p -e -t ${sh(spec.sessionName)}`)
      .then((r) => {
        if (stopped || r.exitCode !== 0) return;
        if (r.stdout === last) return;
        last = r.stdout;
        process.stdout.write('\x1b[H\x1b[2J' + r.stdout);
      })
      .catch(() => {
        // transient SDK error — next tick retries
      });
  }, POLL_INTERVAL_MS);

  return new Promise<number>((resolve) => {
    const finish = (): void => {
      cleanup();
      resolve(0);
    };
    stdin.on('end', finish);
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    // Resolve when cleanup() runs from the detach key.
    const detachWatch = setInterval(() => {
      if (stopped) {
        clearInterval(detachWatch);
        resolve(0);
      }
    }, 50);
  });
}

/** Read-only log/output streaming (kind === 'logs'): no input pump. */
async function runLogs(sb: SandboxType, spec: AttachHelperSpec): Promise<number> {
  const r = await sb.runCommand({
    cmd: 'bash',
    args: ['-lc', `sudo -u vscode -H bash -lc ${sh(spec.command)}`],
    sudo: true,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  return r.exitCode;
}

export async function attachMain(argv: string[]): Promise<number> {
  const sandboxId = argv[0];
  const specB64 = argv[1];
  if (!sandboxId || !specB64) {
    process.stderr.write('vercel attach-helper: usage: <sandboxId> <base64-spec>\n');
    return 2;
  }
  const spec = JSON.parse(Buffer.from(specB64, 'base64').toString('utf8')) as AttachHelperSpec;
  await ensureFreshCredentials();
  const sb = await Sandbox.get({ name: sandboxId, resume: true, ...resolveCredentials() });

  if (spec.detached) {
    await ensureSession(sb, spec);
    return 0;
  }
  if (spec.kind === 'logs') {
    return runLogs(sb, spec);
  }
  return runInteractive(sb, spec);
}

// Entry point when spawned as a process (tsup builds this file to a dist entry).
// Guarded so importing the module (tests) doesn't run the bridge.
if (process.argv[1] && /attach-helper\.(js|cjs|mjs|ts)$/.test(process.argv[1])) {
  attachMain(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`vercel attach-helper: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
