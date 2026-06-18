import net from 'node:net';

/**
 * Minimal client for Herdr's local socket API (https://herdr.dev/docs/socket-api).
 *
 * Herdr speaks newline-delimited JSON-RPC over a UNIX domain socket: each
 * request is one `{"id","method","params"}` object on its own line, each reply
 * one `{"id","result"|"error"}` line. We talk to it directly (the way Herdr's
 * own agent hooks do) rather than shelling out to a `herdr` binary, so the
 * integration has no PATH / `HERDR_BIN_PATH` dependency.
 *
 * Everything here is best-effort: a missing socket, a refused connect, or a
 * timeout is swallowed. The attach wrapper must never crash or block because
 * Herdr is unreachable.
 */

/** Resolve the active Herdr session socket, if any. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const sock = env['HERDR_SOCKET_PATH'];
  return typeof sock === 'string' && sock.length > 0 ? sock : undefined;
}

let reqSeq = 0;
function nextId(): string {
  reqSeq += 1;
  return `agentbox:${String(reqSeq)}`;
}

/**
 * Fire-and-forget a Herdr request: connect, write one line, close. Never
 * throws, never blocks the caller (the socket work finishes on its own).
 */
export function herdrSend(
  method: string,
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sock = herdrSocketPath(env);
  if (!sock) return;
  try {
    const client = net.connect(sock);
    client.on('error', () => {});
    client.on('connect', () => {
      try {
        client.write(`${JSON.stringify({ id: nextId(), method, params })}\n`);
      } catch {
        // best-effort
      }
      client.end();
    });
  } catch {
    // best-effort: socket gone / connect refused
  }
}

/**
 * Send a Herdr request and resolve the first response line's `result`. Resolves
 * `null` on any error (no socket, refused connect, error reply, timeout) so
 * callers can fall back. Used by the spawn paths, which need the created
 * pane id echoed back.
 */
export function herdrRequest(
  method: string,
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  const sock = herdrSocketPath(env);
  if (!sock) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };
    let buf = '';
    let client: net.Socket;
    try {
      client = net.connect(sock);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();
    client.on('error', () => done(null));
    client.on('close', () => done(null));
    client.on('connect', () => {
      try {
        client.write(`${JSON.stringify({ id: nextId(), method, params })}\n`);
      } catch {
        done(null);
      }
    });
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line) as { result?: unknown; error?: unknown };
        if (msg.error || typeof msg.result !== 'object' || msg.result === null) {
          done(null);
        } else {
          clearTimeout(timer);
          done(msg.result as Record<string, unknown>);
        }
      } catch {
        done(null);
      }
    });
  });
}
