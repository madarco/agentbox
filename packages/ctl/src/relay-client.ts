import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveRelayEnv } from './relay-env.js';

/**
 * Minimal outbound HTTP client used by the supervisor to forward events to
 * the host relay (`agentbox-relay`). Fire-and-forget — failures are silently
 * swallowed so a relay outage never blocks the supervisor.
 *
 * Reads AGENTBOX_RELAY_URL and AGENTBOX_RELAY_TOKEN from process.env, falling
 * back to the cloud daemon's `0600` relay-env file (see `relay-env.ts`). If
 * neither yields both, `enabled` is false and `post()` is a no-op.
 */
export class RelayClient {
  private readonly url: URL | null;
  private readonly token: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const resolved = resolveRelayEnv(env);
    const rawUrl = resolved.url;
    const token = resolved.token ?? '';
    let url: URL | null = null;
    if (rawUrl && token.length > 0) {
      try {
        url = new URL(rawUrl);
      } catch {
        url = null;
      }
    }
    this.url = url;
    this.token = token;
  }

  get enabled(): boolean {
    return this.url !== null;
  }

  post(type: string, payload: unknown): void {
    if (!this.url) return;
    const url = this.url;
    const body = JSON.stringify({ type, ts: new Date().toISOString(), payload });
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;
    const req = transport(
      {
        host: url.hostname,
        port,
        method: 'POST',
        path: `${url.pathname.replace(/\/$/, '')}/events`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          Authorization: `Bearer ${this.token}`,
        },
        timeout: 2000,
      },
      (res) => {
        // Drain so the socket can be reused.
        res.resume();
      },
    );
    req.on('error', () => {
      // best-effort
    });
    req.on('timeout', () => {
      req.destroy();
    });
    req.write(body);
    req.end();
  }
}
