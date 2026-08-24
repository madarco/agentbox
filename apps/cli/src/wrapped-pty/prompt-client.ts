import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { BoxNoticeEvent, PromptAnswerBody, PromptAskEvent } from '@agentbox/relay';

/**
 * SSE subscription to the hub's `GET /api/v1/boxes/:id/stream`. The hub pushes:
 *   - `event: open`            data: {}                  (first frame of every connect)
 *   - `event: prompt-ask`      data: PromptAskEvent (with id)
 *   - `event: prompt-resolved` data: { id }
 *   - `event: notice-set`      data: BoxNoticeEvent (with id)
 *   - `event: notice-clear`    data: { id }
 *   - `event: box-status`      data: BoxStatus snapshot
 *   - `event: ping`            data: { ts }
 *
 * `box-status` is why the footer needs no polling: the in-box daemon already
 * pushes a snapshot on change (debounced) plus a 15s heartbeat, and this is the
 * socket that is open anyway. It is the ONLY status source for a box owned by a
 * remote hub — the host's `~/.agentbox/boxes/<id>/status.json` is written by the
 * LOCAL relay, so it never exists for a box whose daemon reports elsewhere.
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
  /**
   * A fresh box-status snapshot. Opaque here (the typed `BoxStatus` lives in
   * @agentbox/ctl); the footer parses it.
   */
  onStatus?: (snapshot: unknown) => void;
  /**
   * A *re*connect completed — fired on `open` for every connect after the
   * first. The caller must drop the prompt/notice state it is holding: anything
   * still live is re-sent by the backlog flush that follows this event within
   * the same stream, so whatever isn't re-sent was resolved during the outage
   * (e.g. answered from the web UI) and would otherwise stay pinned forever.
   */
  onReconnect?: () => void;
  /**
   * `fatal` distinguishes "this will never work" (a credential the hub rejects,
   * after which the stream is closed) from "the hub is away and we are still
   * retrying". Only the former deserves a user-facing band — a hub restart is
   * routine and self-healing, and reporting it the same way would cry wolf on
   * every `hub update`.
   */
  onError?: (err: Error, fatal: boolean) => void;
}

const INITIAL_BACKOFF_MS = 200;
/**
 * Ceiling for the reconnect backoff. Sized for the worst real outage: a
 * `hub update` rebuilds the control box's image in place, which is minutes of
 * 502s from its reverse proxy. Retrying that every 5s is pointless noise.
 */
const MAX_BACKOFF_MS = 30_000;

/**
 * Statuses worth giving up on. Only a credential problem qualifies: no amount
 * of retrying conjures an API key, so we surface it and stop.
 *
 * Everything else retries — notably 404, which is transient right after a
 * control box restarts (the box registry rehydrates from the durable store, so
 * a stream can briefly outrun it), and the 5xx family a reverse proxy returns
 * while the hub container is being replaced. Treating those as fatal is what
 * used to leave the footer permanently silent after a `hub update`, with a
 * detach/reattach as the only cure.
 */
function isFatalStatus(status: number): boolean {
  return status === 401 || status === 403;
}

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
    if (opts.onError) opts.onError(err instanceof Error ? err : new Error(String(err)), true);
    return { close: () => {} };
  }
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

  function scheduleReconnect(): void {
    if (closed) return;
    // Jitter across the top half of the window: many wrappers attached to boxes
    // on the same hub all lose the socket at the same instant when it restarts,
    // and un-jittered backoff would march them back in lockstep.
    const delay = backoffMs / 2 + Math.random() * (backoffMs / 2);
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
  /** Set on the first `open`; distinguishes a reconnect from the initial connect. */
  let everConnected = false;
  /** One log line per outage, not one per retry. Cleared on a healthy connect. */
  let reportedOutage = false;
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
      if (event === 'open') {
        // First frame of every connect, and it precedes the backlog flush — the
        // one moment at which the caller can safely discard state without
        // racing a live prompt.
        if (everConnected) opts.onReconnect?.();
        everConnected = true;
      } else if (event === 'box-status' && dataLine.length > 0) {
        try {
          opts.onStatus?.(JSON.parse(dataLine));
        } catch {
          /* malformed; ignore rather than die */
        }
      } else if (event === 'prompt-ask' && dataLine.length > 0) {
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
    // Start every connection with a clean parse buffer. A drop mid-frame leaves
    // a partial message behind, and the next connection's `open` would be
    // concatenated onto it — the two would parse as one garbage event, so the
    // `open` is swallowed and the reconnect resync never fires. That is exactly
    // the stale-prompt failure this client is meant to fix.
    buffer = '';
    req = transport({
      host: url.hostname,
      port,
      method: 'GET',
      path: `${url.pathname.replace(/\/$/, '')}/api/v1/boxes/${encodeURIComponent(opts.boxId)}/stream`,
      headers: {
        Accept: 'text/event-stream',
        ...(opts.hubApiKey ? { Authorization: `Bearer ${opts.hubApiKey}` } : {}),
      },
    });
    req.on('response', (r) => {
      res = r;
      const status = r.statusCode ?? 0;
      if (status !== 200) {
        r.resume(); // drain, or the socket never frees
        if (isFatalStatus(status)) {
          if (opts.onError) opts.onError(new Error(`SSE stream returned ${String(status)}`), true);
          close();
          return;
        }
        if (!reportedOutage) {
          reportedOutage = true;
          if (opts.onError) {
            opts.onError(new Error(`SSE stream returned ${String(status)}; retrying`), false);
          }
        }
        scheduleReconnect();
        return;
      }
      backoffMs = INITIAL_BACKOFF_MS; // reset on a healthy connect
      reportedOutage = false;
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
