/**
 * Short-lived TCP listener that speaks git's credential-helper protocol.
 * Started on demand by the relay's git fast path for HTTPS origins, exposed
 * into the box via `ssh -R <inboxPort>:127.0.0.1:<proxyPort>`. The in-box
 * git config then routes the credential helper through that port:
 *
 *   git -c credential.helper='!f() { nc 127.0.0.1 <inboxPort>; }; f' push …
 *
 * Per connection: read the input block ("protocol=…\nhost=…\n[path=…]\n\n"),
 * shell out to `git credential fill` on the host (which uses the user's
 * configured helper — osxkeychain, libsecret, `gh auth git-credential`, …),
 * write the response back, close.
 *
 * Lifetime: proxy is started before the `ssh -A -R` exec and stopped in
 * `finally`, so the in-box socket disappears as soon as the push/fetch
 * returns. The token is never written to a file or env var inside the box.
 *
 * Binds 127.0.0.1 only; a box-resident attacker with simultaneous shell
 * access could connect to the forwarded port during the push window, but a
 * box-resident attacker already has the user's working tree — no new
 * exposure surface in practice.
 */

import { execa } from 'execa';
import { createServer, type Server, type Socket } from 'node:net';

export interface HostCredentialProxy {
  /** Loopback port the proxy is listening on (host side). */
  port: number;
  /** Tear down the listener. Idempotent. */
  stop: () => Promise<void>;
}

export interface StartHostCredentialProxyOpts {
  /** Per-connection timeout (read + git credential fill). Defaults to 5s. */
  perRequestTimeoutMs?: number;
  /**
   * Run `git credential fill` from this cwd so the host repo's per-remote
   * `credential.<url>.helper` overrides resolve. Defaults to process.cwd().
   */
  hostRepo?: string;
  /** Best-effort logger. */
  log?: (line: string) => void;
}

export async function startHostCredentialProxy(
  opts: StartHostCredentialProxyOpts = {},
): Promise<HostCredentialProxy> {
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? 5_000;
  const log = opts.log ?? (() => {});

  // allowHalfOpen: TRUE — net.createServer's default is `false`, which auto-
  // ends our write side as soon as the client closes its read side. The
  // in-box client (`nc -N`) shuts down its write side after sending the
  // credential request and then waits to read the response from us; if we
  // half-close eagerly, the response is dropped before the client receives
  // it. allowHalfOpen: true keeps the write side open until we explicitly
  // call socket.end(response). This was the root cause of the v1 HTTPS
  // fast-path failures during development.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    log(`host-credential-proxy: connection from ${socket.remoteAddress ?? '(no peer)'}`);
    handleClient(socket, { perRequestTimeoutMs, hostRepo: opts.hostRepo, log }).catch((err) => {
      log(`host-credential-proxy: client handler crashed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        socket.destroy();
      } catch {
        /* best-effort */
      }
    });
  });

  const port = await new Promise<number>((resolveOk, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('host-credential-proxy: could not bind ephemeral port'));
        return;
      }
      resolveOk(addr.port);
    });
  });
  log(`host-credential-proxy: listening on 127.0.0.1:${String(port)}`);

  return {
    port,
    stop: () =>
      new Promise<void>((resolveOk) => {
        server.close(() => {
          log(`host-credential-proxy: stopped (port ${String(port)})`);
          resolveOk();
        });
      }),
  };
}

async function handleClient(
  socket: Socket,
  ctx: { perRequestTimeoutMs: number; hostRepo?: string; log: (line: string) => void },
): Promise<void> {
  // Defensive: reject non-loopback peers. createServer host=127.0.0.1 already
  // enforces this at bind time, but pin it explicitly.
  const peer = socket.remoteAddress;
  if (peer && peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') {
    ctx.log(`host-credential-proxy: refused non-loopback peer ${peer}`);
    socket.destroy();
    return;
  }
  // Read input until EOF (end-of-input from the client's half-close). Modern
  // git (2.45+) appends `wwwauth[]=…` lines without a trailing blank line and
  // relies on EOF to delimit, so we can't watch for "\n\n" alone.
  socket.setTimeout(ctx.perRequestTimeoutMs);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveOk, reject) => {
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('end', () => resolveOk());
    socket.on('timeout', () => reject(new Error('client read timed out')));
    socket.on('error', reject);
  });

  const input = Buffer.concat(chunks).toString('utf8');
  if (input.length === 0) {
    ctx.log('host-credential-proxy: empty request');
    socket.end();
    return;
  }

  let res;
  try {
    res = await execa('git', ['credential', 'fill'], {
      input,
      reject: false,
      timeout: ctx.perRequestTimeoutMs,
      cwd: ctx.hostRepo,
      env: {
        ...process.env,
        // Make sure git doesn't pop a terminal prompt — we want it to either
        // succeed with the configured helper or fail immediately so the caller
        // can fall back to the bundle path.
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch (err) {
    ctx.log(
      `host-credential-proxy: git credential fill threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    socket.end();
    return;
  }

  if (res.exitCode !== 0 || typeof res.stdout !== 'string' || res.stdout.length === 0) {
    ctx.log(
      `host-credential-proxy: git credential fill returned no credentials (exit ${String(res.exitCode)})`,
    );
    socket.end();
    return;
  }

  // Write response + half-close. We rely on `allowHalfOpen: true` on the
  // server so this write isn't dropped after we already got the client's FIN.
  await new Promise<void>((resolveOk) => {
    const trailing = res.stdout.endsWith('\n\n') ? '' : '\n';
    socket.end(res.stdout + trailing, () => resolveOk());
  });
}
