import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Tiny in-box reverse proxy used by `agentbox-ctl daemon` in docker boxes.
 *
 * In cloud boxes the daemon embeds a real `mode: 'box'` relay; in docker
 * boxes there is no relay to embed (the host relay runs on the host and is
 * reachable at `host.docker.internal:8787`). The forwarder gives docker
 * boxes a symmetric in-box endpoint on the same port the cloud path uses,
 * so the in-box ctl client always points at `http://127.0.0.1:<port>` and
 * a nested agentbox can claim the host-relay port (8787) inside the outer
 * box without colliding.
 *
 * It is intentionally minimal: no auth check (the host relay is the single
 * source of truth — we pass the bearer header through verbatim), no body
 * buffering (streams the request and response so long-blocking `/rpc`
 * calls work), and a whitelist of two endpoints (`/rpc` and `/events` —
 * the only ones the in-box ctl client uses).
 */
export interface BoxRelayForwarderOptions {
  port: number;
  upstream: URL;
  logger?: (line: string) => void;
}

export interface BoxRelayForwarderHandle {
  url: string;
  close: () => Promise<void>;
}

const ALLOWED_PATHS = new Set(['/rpc', '/events']);

export function startBoxRelayForwarder(
  opts: BoxRelayForwarderOptions,
): Promise<BoxRelayForwarderHandle> {
  const log = opts.logger ?? ((): void => {});
  const upstream = opts.upstream;
  const isTls = upstream.protocol === 'https:';
  const upstreamPort =
    upstream.port.length > 0 ? Number.parseInt(upstream.port, 10) : isTls ? 443 : 80;
  // The hosted control plane is reached over public HTTPS (behind the
  // provider's proxy); the laptop relay over plain HTTP at host.docker.internal.
  // Pick the matching client so TLS termination works for the cloud path.
  const requestFn = isTls ? httpsRequest : httpRequest;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method !== 'POST' || !ALLOWED_PATHS.has(path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    const headers = { ...req.headers };
    // The upstream is a different host:port; let node recompute Host so it
    // matches host.docker.internal:8787 instead of 127.0.0.1:8788.
    delete headers.host;
    delete headers.connection;

    const upstreamReq = requestFn(
      {
        host: upstream.hostname,
        port: upstreamPort,
        method: 'POST',
        path: `${upstream.pathname.replace(/\/$/, '')}${path}`,
        headers,
        // No keep-alive: the relay holds /rpc open for the lifetime of a
        // host prompt (potentially many seconds). Reusing sockets across
        // such calls invites mid-stream resets on Node version drift.
        agent: false,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (err) => {
      log(`upstream error on ${path}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end();
    });
    req.on('error', (err) => {
      log(`client error on ${path}: ${err.message}`);
      upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  });

  return new Promise<BoxRelayForwarderHandle>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onError);
    server.listen(opts.port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve({
        url: `http://127.0.0.1:${String(opts.port)}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
