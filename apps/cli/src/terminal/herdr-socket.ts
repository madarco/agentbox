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
 * Send a Herdr request and resolve the reply's `result`. Resolves `null` on any
 * error (no socket, refused connect, error reply, timeout) so callers can fall
 * back. Used by the spawn paths, which need the created pane id echoed back.
 *
 * Reply correlation matters under concurrency: when several boxes' queue
 * workers each open a Herdr connection and ask it to create a tab at once,
 * Herdr can push a notification (a focus/layout event) onto the connection
 * *before* the RPC reply. The old "take the first line with a `result`" logic
 * mis-read that notification as the answer and reported "gave no pane id" even
 * though the tab was created. We now scan line-by-line and consume only the line
 * carrying OUR request `id` (an id-less reply is still accepted, so a
 * non-compliant Herdr that omits the echo doesn't regress), skipping
 * notifications (no `result`/`error`) and any other request's reply.
 */
export function herdrRequest(
  method: string,
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  const sock = herdrSocketPath(env);
  if (!sock) return Promise.resolve(null);
  const id = nextId();
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
        client.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        done(null);
      }
    });
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      // Drain every complete line; ignore anything that isn't our reply and
      // keep reading until the matching id arrives or the timeout fires.
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let msg: { id?: unknown; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue; // partial/garbage line — wait for more data
        }
        // Notifications (method+params, no result/error) aren't replies — skip.
        if (!('result' in msg) && !('error' in msg)) continue;
        // A reply for a different request on this connection — not ours.
        if (msg.id !== undefined && msg.id !== id) continue;
        if (msg.error || typeof msg.result !== 'object' || msg.result === null) {
          done(null);
        } else {
          done(msg.result as Record<string, unknown>);
        }
        return;
      }
    });
  });
}
