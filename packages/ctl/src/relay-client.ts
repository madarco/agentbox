import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveRelayEnv } from './relay-env.js';

/**
 * Minimal outbound HTTP client used by the supervisor to forward events to
 * the host relay (`agentbox-relay`). A relay outage never blocks the
 * supervisor: `post()` never rejects, it reports the outcome instead.
 *
 * Most callers stay fire-and-forget (`void relay.post(...)`) because their
 * events are periodic snapshots a later tick supersedes. The credentials
 * watcher is the exception — a Claude refresh rotates the token, so a lost post
 * means every other copy of that login is dead with no trace. It awaits the
 * outcome and only records the post as done once the relay has it.
 *
 * Reads AGENTBOX_RELAY_URL and AGENTBOX_RELAY_TOKEN from process.env, falling
 * back to the cloud daemon's `0600` relay-env file (see `relay-env.ts`). If
 * neither yields both, `enabled` is false and `post()` is a no-op.
 */

/**
 * What became of one `post()`. `ok` is a 2xx. `status` is null when the request
 * never got an answer (connection error, timeout) — the retryable case; a
 * status lets the caller tell a permanent rejection (4xx: this payload will
 * never be accepted) from a transient one (5xx).
 *
 * Note a credentials event answers 202 `{ accepted: false }` when the relay's
 * newest-wins gate judges the blob stale. That is delivery, not failure — the
 * status is what matters here, never the body.
 */
export interface PostOutcome {
  ok: boolean;
  status: number | null;
}

/** Default per-request budget. Callers that must not lose the event pass more. */
const DEFAULT_TIMEOUT_MS = 2000;

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

  post(type: string, payload: unknown, opts: { timeoutMs?: number } = {}): Promise<PostOutcome> {
    if (!this.url) return Promise.resolve({ ok: false, status: null });
    const url = this.url;
    const body = JSON.stringify({ type, ts: new Date().toISOString(), payload });
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;
    return new Promise<PostOutcome>((resolve) => {
      // Exactly one settle: a request can both time out and error.
      let settled = false;
      const done = (outcome: PostOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
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
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? null;
          // Drain so the socket can be reused, and settle only once the body is
          // gone — resolving early can leave the socket half-read.
          res.resume();
          res.on('end', () => {
            done({ ok: status !== null && status >= 200 && status < 300, status });
          });
          res.on('error', () => {
            done({ ok: false, status: null });
          });
        },
      );
      req.on('error', () => {
        done({ ok: false, status: null });
      });
      req.on('timeout', () => {
        req.destroy();
        done({ ok: false, status: null });
      });
      req.write(body);
      req.end();
    });
  }
}
