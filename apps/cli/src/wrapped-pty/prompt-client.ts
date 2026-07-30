import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { BoxNoticeEvent, PromptAnswerBody, PromptAskEvent } from '@agentbox/relay';

/**
 * SSE subscription to the hub's `GET /api/v1/boxes/:id/prompts/stream`. The
 * hub pushes:
 *   - `event: prompt-ask`      data: PromptAskEvent (with id)
 *   - `event: prompt-resolved` data: { id }
 *   - `event: notice-set`      data: BoxNoticeEvent (with id)
 *   - `event: notice-clear`    data: { id }
 *   - `event: ping`            data: { ts }
 *
 * We reconnect with exponential backoff on any error or close — the only
 * way to know the hub is back is to keep trying.
 *
 * The hub is usually the laptop's own local hub (sub-ms loopback), but a box
 * created against a control box streams from THAT hub instead — over the WAN,
 * possibly https. Either way the stream is gated exactly like the rest of
 * `/api/v1`, so `hubApiKey` is the Bearer for both: the local hub's token, or the
 * control box's `AGENTBOX_HUB_API_KEY`. Without it a password-profile hub rejects
 * the subscriber and the footer stays silent on exactly the boxes that need it
 * most. The backoff loop already absorbs the flakier link; don't add tight
 * timeouts here.
 */
export interface PromptStream {
  /** Stop subscribing; aborts any in-flight reconnect attempt. */
  close(): void;
}

export interface SubscribeOptions {
  hubBaseUrl: string;
  /**
   * The hub API Bearer (local hub token, or a control box's AGENTBOX_HUB_API_KEY).
   * Omitted only when the hub couldn't be authenticated (the footer then degrades
   * silently, same as before).
   */
  hubApiKey?: string;
  boxId: string;
  onPrompt: (ev: PromptAskEvent) => void;
  /** Server-driven: a sibling wrapper (or this one) answered; the run loop
   *  clears the footer for stale ids it didn't originate. */
  onResolved: (id: string) => void;
  /** A box-level informational notice was set (e.g. checkpoint in progress). */
  onNotice?: (ev: BoxNoticeEvent) => void;
  /** A previously-set notice was cleared (explicitly or via its TTL). */
  onNoticeCleared?: (id: string) => void;
  onError?: (err: Error) => void;
}

const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5_000;

export function subscribePrompts(opts: SubscribeOptions): PromptStream {
  let closed = false;
  let req: ReturnType<typeof httpRequest> | null = null;
  let res: IncomingMessage | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let url: URL;
  try {
    url = new URL(opts.hubBaseUrl);
  } catch (err) {
    if (opts.onError) opts.onError(err instanceof Error ? err : new Error(String(err)));
    return { close: () => {} };
  }
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

  function scheduleReconnect(): void {
    if (closed) return;
    const delay = backoffMs;
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  /**
   * SSE message parser: server sends `event: <type>\n` then `data: <json>\n\n`.
   * The relay never splits an event across writes (one chunk per dispatch),
   * but we still buffer by message boundary `\n\n` so a mid-message slice
   * doesn't corrupt parsing.
   */
  let buffer = '';
  function consumeMessages(): void {
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');
      // Drop the SSE comment line we send on connect (`: connected`).
      if (raw.startsWith(':')) continue;
      let event = '';
      let dataLine = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) dataLine = line.slice('data:'.length).trim();
      }
      if (event === 'prompt-ask' && dataLine.length > 0) {
        try {
          const ev = JSON.parse(dataLine) as PromptAskEvent;
          if (ev && typeof ev.id === 'string') opts.onPrompt(ev);
        } catch {
          /* malformed; relay should never send this — ignore rather than die */
        }
      } else if (event === 'prompt-resolved' && dataLine.length > 0) {
        try {
          const payload = JSON.parse(dataLine) as { id?: string };
          if (payload && typeof payload.id === 'string') opts.onResolved(payload.id);
        } catch {
          /* malformed; ignore */
        }
      } else if (event === 'notice-set' && dataLine.length > 0) {
        try {
          const ev = JSON.parse(dataLine) as BoxNoticeEvent;
          if (ev && typeof ev.id === 'string') opts.onNotice?.(ev);
        } catch {
          /* malformed; ignore */
        }
      } else if (event === 'notice-clear' && dataLine.length > 0) {
        try {
          const payload = JSON.parse(dataLine) as { id?: string };
          if (payload && typeof payload.id === 'string') opts.onNoticeCleared?.(payload.id);
        } catch {
          /* malformed; ignore */
        }
      }
      // 'ping' has no caller-visible side effect — its purpose is to keep
      // the socket from going idle and to let the wrapper detect dead links
      // via socket-level errors. No-op here.
    }
  }

  function connect(): void {
    if (closed) return;
    req = transport({
      host: url.hostname,
      port,
      method: 'GET',
      path: `${url.pathname.replace(/\/$/, '')}/api/v1/boxes/${encodeURIComponent(opts.boxId)}/prompts/stream`,
      headers: {
        Accept: 'text/event-stream',
        ...(opts.hubApiKey ? { Authorization: `Bearer ${opts.hubApiKey}` } : {}),
      },
    });
    req.on('response', (r) => {
      res = r;
      if (r.statusCode !== 200) {
        // 401/404 — the hub says "no for you"; bail without retrying since these
        // are config errors (bad/absent API key, unknown box) that won't fix
        // themselves.
        if (opts.onError) opts.onError(new Error(`SSE stream returned ${String(r.statusCode)}`));
        r.resume();
        close();
        return;
      }
      backoffMs = INITIAL_BACKOFF_MS; // reset on a healthy connect
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => {
        buffer += chunk;
        consumeMessages();
      });
      r.on('end', () => {
        if (!closed) scheduleReconnect();
      });
      r.on('error', () => {
        if (!closed) scheduleReconnect();
      });
    });
    req.on('error', () => {
      if (!closed) scheduleReconnect();
    });
    req.end();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      res?.destroy();
    } catch {
      /* best-effort */
    }
    try {
      req?.destroy();
    } catch {
      /* best-effort */
    }
  }

  connect();
  return { close };
}

/**
 * POST an answer to `/api/v1/approvals/:id/answer`. Fire-and-(mostly)-forget: we
 * don't retry on failure because the backend's resolve is idempotent and a
 * double-resolve returns 404. If the hub was dead, the SSE reconnect loop will
 * repush any prompts that are still pending.
 */
export interface PostAnswerOptions {
  hubBaseUrl: string;
  /** The hub API Bearer (local hub token, or a control box's AGENTBOX_HUB_API_KEY). */
  hubApiKey?: string;
  body: PromptAnswerBody;
}

export interface PostAnswerResult {
  ok: boolean;
  status: number;
}

export function postAnswer(opts: PostAnswerOptions): Promise<PostAnswerResult> {
  return new Promise<PostAnswerResult>((resolve) => {
    let url: URL;
    try {
      url = new URL(opts.hubBaseUrl);
    } catch {
      resolve({ ok: false, status: 0 });
      return;
    }
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;
    // The id rides the path; the v1 answer body carries answer (+ optional
    // `cancelled`, the dismissal marker the footer never sends but the route
    // accepts, so `agent approve --cancel` keeps its meaning through v1).
    const json = JSON.stringify({
      answer: opts.body.answer,
      ...(opts.body.cancelled ? { cancelled: true } : {}),
    });
    const req = transport(
      {
        host: url.hostname,
        port,
        method: 'POST',
        path: `${url.pathname.replace(/\/$/, '')}/api/v1/approvals/${encodeURIComponent(opts.body.id)}/answer`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json).toString(),
          ...(opts.hubApiKey ? { Authorization: `Bearer ${opts.hubApiKey}` } : {}),
        },
        // Generous enough for a WAN round-trip to a control box, not just the
        // loopback hub this once only spoke to.
        timeout: 8000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        // 200 = accepted; 404 = already answered (idempotent). Both are "done".
        resolve({ ok: status === 200 || status === 404, status });
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    req.write(json);
    req.end();
  });
}
