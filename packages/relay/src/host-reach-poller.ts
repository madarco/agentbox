/**
 * `HostReachPoller` — the PC-resident loop that drains host actions parked on a
 * control box (`/admin/hostreach/*`) and executes them against the real project
 * files on this machine.
 *
 * The counterpart to {@link CloudBoxPoller}: execute, post the result back, back
 * off on failure. The difference is direction — that one reaches *into* a box,
 * this one reaches *out* to the control box, because a laptop behind NAT can't
 * be dialled.
 *
 * Two transports, same work: an SSE stream when the network allows one, and the
 * long poll when it doesn't. The stream is preferred because a machine then
 * holds one connection and its presence IS that connection; the poll survives
 * proxies that buffer event streams and control boxes too old to serve the
 * route. Neither can be detected without trying, so the loop tries the stream,
 * falls back on the first hard evidence against it, and retries it later.
 *
 * Running this is what makes `cp` between a hub box and your machine mean your
 * machine. Without it the control box has no way to touch the user's files
 * (see `docs/plans/box-cp-host-reach-plan.md`), and every idle poll doubles as
 * the "I'm still here" heartbeat the control box uses to decide whether to wait
 * for a live copy or fall back to the custody cache.
 */

import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { SseFrameReader } from './sse-read.js';
import type { HostAction, HostActionResult } from './types.js';

export interface HostReachPollerDeps {
  /** Control box base URL (`relay.controlPlaneUrl`). */
  controlPlaneUrl: string;
  /** Admin bearer — the only credential `/admin/hostreach/*` accepts remotely. */
  adminToken: string;
  /**
   * Execute one drained action on this machine. MUST resolve with a result even
   * on failure (a rejection is caught and turned into a non-zero result), or the
   * box on the other end waits forever.
   */
  execute: (action: HostAction) => Promise<HostActionResult | 'not-mine'>;
  /**
   * Land any copies that were parked for this machine while it was offline.
   * Started (never awaited) on first contact and re-checked periodically; it
   * opens a confirm per item, so it must not gate the poll loop.
   */
  drainOutbox?: () => Promise<void>;
  logger?: (line: string) => void;
}

/**
 * How long the server holds an idle poll open. Kept under the 30s most reverse
 * proxies use as their default idle timeout (the control box runs behind Caddy),
 * so a quiet loop looks like a slow response rather than a hung connection.
 */
const POLL_WAIT_MS = 25_000;
/** Client-side ceiling: the server answers at POLL_WAIT_MS, so this only catches a wedged connection. */
const REQUEST_TIMEOUT_MS = 40_000;
const RESULT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** How often a long-lived poller re-checks the outbox after its first look. */
const OUTBOX_RECHECK_MS = 5 * 60_000;
/** After the stream proves unusable, how long to stay on the poll before retrying it. */
const SSE_RETRY_MS = 5 * 60_000;
/** A stream that sends nothing at all in this window is being buffered somewhere. */
const SSE_HANDSHAKE_MS = 10_000;

interface JsonResponse {
  status: number;
  text: string;
}

export class HostReachPoller {
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private backoffMs = 0;
  /** Suppresses repeat log lines while a control box stays unreachable. */
  private loggedFailure = false;
  /**
   * Identity of THIS process. Sent with every poll so the control box can tell a
   * restarted relay from the one that took an action and never came back — and
   * re-offer that orphaned work instead of leaving the box waiting forever.
   */
  private readonly pollerId = randomUUID();
  /** Set while a drain is in flight, so only one runs at a time. */
  private drainingOutbox = false;
  /** Epoch ms of the last drain, for the periodic re-check. */
  private lastDrainAtMs = 0;
  /** Serializes execution beside the poll loop (see {@link enqueue}). */
  private workQueue: Promise<void> = Promise.resolve();
  /** Epoch ms before which the stream is not retried (0 = try it now). */
  private sseBlockedUntilMs = 0;
  /** Logged once per transition so the log answers "which mode am I in?". */
  private mode: 'stream' | 'poll' | null = null;
  /**
   * The in-flight event stream, so {@link stop} can cut it.
   *
   * An open stream never ends on its own: without this, stopping the relay
   * waits for the control box to drop the connection, which it has no reason to
   * do — `agentbox relay stop` would hang.
   */
  private activeStream: { destroy: () => void } | null = null;

  constructor(private readonly deps: HostReachPollerDeps) {}

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.run().catch((err: unknown) => {
      this.log(`host-reach poller crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.activeStream?.destroy();
    if (this.loopPromise) await this.loopPromise;
    // Let an in-flight copy finish rather than abandoning a box mid-transfer.
    await this.workQueue.catch(() => {});
  }

  private async run(): Promise<void> {
    const base = this.deps.controlPlaneUrl.replace(/\/+$/, '');
    this.log(`host-reach: connecting to ${base} for host actions`);
    while (!this.stopped) {
      // Stream when we can, poll when we can't. The stream is preferred (one
      // connection, presence is the connection); the poll is what keeps this
      // working through a proxy that buffers event streams, or against a
      // control box too old to serve the route — neither of which we can detect
      // any way other than trying.
      if (this.streamingAllowed()) {
        const outcome = await this.stream(base);
        if (this.stopped) break;
        if (outcome === 'fatal') return;
        if (outcome === 'unsupported' || outcome === 'unusable') {
          this.sseBlockedUntilMs = Date.now() + SSE_RETRY_MS;
          this.log(
            outcome === 'unsupported'
              ? 'host-reach: control box has no event stream; falling back to long polling'
              : 'host-reach: event stream did not come through (a proxy may be buffering it); falling back to long polling',
          );
        }
        // A stream that WAS established and then dropped is an ordinary
        // reconnect: loop straight back and try to stream again.
        continue;
      }
      try {
        const res = await this.get(
          `${base}/admin/hostreach/poll?wait=${String(POLL_WAIT_MS)}&poller=${this.pollerId}`,
        );
        if (res.status === 404) {
          // An older control box has no host-reach surface. Nothing this loop
          // can do until it is updated; say so once and stop pestering it.
          this.log(
            'host-reach: this control box does not serve /admin/hostreach (update it) — poller stopping',
          );
          return;
        }
        if (res.status === 401 || res.status === 403) {
          this.log(
            'host-reach: control box rejected the admin token — poller stopping (re-run `agentbox hub setup`)',
          );
          return;
        }
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`poll → ${String(res.status)}: ${res.text.slice(0, 200)}`);
        }
        this.backoffMs = 0;
        if (this.loggedFailure) {
          this.log('host-reach: control box reachable again');
          this.loggedFailure = false;
        }
        if (this.mode !== 'poll') {
          this.mode = 'poll';
          this.log('host-reach: long polling for host actions');
        }
        this.maybeDrainOutbox();
        const parsed = JSON.parse(res.text.length > 0 ? res.text : '{}') as {
          actions?: HostAction[];
        };
        const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
        for (const action of actions) this.enqueue(base, action);
      } catch (err) {
        if (this.stopped) break;
        if (!this.loggedFailure) {
          this.log(
            `host-reach: control box unreachable (${err instanceof Error ? err.message : String(err)}); retrying`,
          );
          this.loggedFailure = true;
        }
        this.backoffMs = Math.min(
          this.backoffMs === 0 ? BACKOFF_BASE_MS : this.backoffMs * 2,
          BACKOFF_MAX_MS,
        );
        await delay(this.backoffMs);
      }
    }
  }

  /** Whether to attempt the stream, or stay on the poll after it proved unusable. */
  private streamingAllowed(): boolean {
    return Date.now() >= this.sseBlockedUntilMs;
  }

  /**
   * Hold one event stream until it drops.
   *
   * Returns why it ended, which is what decides the next move:
   * - `unsupported` — the route 404s (an older control box). Poll.
   * - `unusable` — connected but nothing arrived, not even the preamble, within
   *   {@link SSE_HANDSHAKE_MS}. Something between here and there is buffering
   *   the response; polling still works through it. Poll.
   * - `dropped` — it worked and then ended (idle timeout, network blip, hub
   *   restart). Reconnect; this is the normal case.
   * - `fatal` — the token was rejected. Neither transport will help.
   */
  private stream(base: string): Promise<'unsupported' | 'unusable' | 'dropped' | 'fatal'> {
    const url = new URL(`${base}/admin/hostreach/events?poller=${this.pollerId}`);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: 'unsupported' | 'unusable' | 'dropped' | 'fatal'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        this.activeStream = null;
        req.destroy();
        resolve(outcome);
      };
      // Nothing at all — not even the `: connected` preamble — means the
      // response is being held somewhere. A stream that is merely quiet still
      // gets its heartbeat well inside this window.
      const handshake = setTimeout(() => finish('unusable'), SSE_HANDSHAKE_MS);
      handshake.unref?.();

      const req = transport(
        {
          host: url.hostname,
          port: url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80,
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          headers: {
            Authorization: `Bearer ${this.deps.adminToken}`,
            Accept: 'text/event-stream',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 404) {
            res.resume();
            finish('unsupported');
            return;
          }
          if (status === 401 || status === 403) {
            res.resume();
            this.log(
              'host-reach: control box rejected the admin token — stopping (re-run `agentbox hub setup`)',
            );
            finish('fatal');
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            finish('unusable');
            return;
          }
          // A proxy that rewrote the response to something buffered is not a
          // stream, whatever the status says.
          if (!(res.headers['content-type'] ?? '').includes('text/event-stream')) {
            res.resume();
            finish('unusable');
            return;
          }
          const reader = new SseFrameReader();
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            // Any byte proves the response is flowing, including the preamble
            // and heartbeats.
            clearTimeout(handshake);
            if (this.mode !== 'stream') {
              this.mode = 'stream';
              this.log('host-reach: streaming host actions (event stream)');
            }
            this.backoffMs = 0;
            this.loggedFailure = false;
            this.maybeDrainOutbox();
            for (const frame of reader.push(chunk)) {
              if (frame.event !== 'action') continue;
              try {
                this.enqueue(base, JSON.parse(frame.data) as HostAction);
              } catch {
                /* a frame we can't parse is not worth dropping the stream for */
              }
            }
          });
          res.on('end', () => finish('dropped'));
          res.on('error', () => finish('dropped'));
        },
      );
      req.on('error', () => finish('unusable'));
      this.activeStream = req;
      req.end();
    });
  }

  /**
   * Kick off an outbox drain, **without** waiting for it.
   *
   * Deliberately not awaited inside the poll loop: a drain opens a confirm per
   * parked copy and blocks until the user answers, so awaiting it here stops
   * this machine polling — the control box then declares it gone and live
   * copies start failing over to the cache while the user is sitting right
   * there. Found exactly that way in a live run.
   *
   * Re-checked periodically rather than once per process: a copy can be parked
   * while this machine is up (a network blip on the control box's side is
   * enough), and a machine that stays online for days would otherwise never
   * look again.
   */
  private maybeDrainOutbox(): void {
    if (!this.deps.drainOutbox || this.drainingOutbox) return;
    if (this.lastDrainAtMs > 0 && Date.now() - this.lastDrainAtMs < OUTBOX_RECHECK_MS) return;
    this.drainingOutbox = true;
    this.lastDrainAtMs = Date.now();
    void this.deps
      .drainOutbox()
      .catch((err: unknown) => {
        this.log(
          `host-reach: could not land parked copies: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.drainingOutbox = false;
      });
  }

  /**
   * Queue an action for execution **off** the poll loop.
   *
   * Executing inline stops this machine polling for as long as the copy takes —
   * and a copy takes as long as the user takes to answer its confirm. The
   * control box reads that silence as "the machine went away", tells the box so,
   * and then has nowhere to put the result that eventually arrives. The poll
   * loop's only job is the heartbeat; work happens beside it.
   *
   * Still strictly sequential: each action can open a confirm, and two prompts
   * competing for one terminal is not a UX.
   */
  private enqueue(base: string, action: HostAction): void {
    this.workQueue = this.workQueue
      .then(() => (this.stopped ? undefined : this.handle(base, action)))
      .catch((err: unknown) => {
        this.log(
          `host-reach: ${action.method} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private async handle(base: string, action: HostAction): Promise<void> {
    this.log(`host-reach: executing ${action.method} for box ${action.boxId}`);
    let result: HostActionResult | 'not-mine';
    try {
      result = await this.deps.execute(action);
    } catch (err) {
      result = {
        exitCode: 1,
        stdout: '',
        stderr: `${action.method} failed on this machine: ${err instanceof Error ? err.message : String(err)}\n`,
      };
    }
    try {
      if (result === 'not-mine') {
        // Hand it back rather than answering for a box this machine has never
        // seen: on a hub with two machines the other one may own it.
        await this.post(`${base}/admin/hostreach/decline`, {
          id: action.id,
          poller: this.pollerId,
        });
        return;
      }
      await this.post(`${base}/admin/hostreach/result`, {
        id: action.id,
        poller: this.pollerId,
        ...result,
      });
    } catch (err) {
      // The box is still blocked on this action; the control box will time it
      // out as 'went-away' once we stop polling, so it can't hang forever.
      this.log(
        `host-reach: could not post the result for ${action.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private get(url: string): Promise<JsonResponse> {
    return this.send(url, 'GET', undefined, REQUEST_TIMEOUT_MS);
  }

  private post(url: string, body: unknown): Promise<JsonResponse> {
    return this.send(url, 'POST', JSON.stringify(body), RESULT_TIMEOUT_MS);
  }

  private send(
    rawUrl: string,
    method: string,
    payload: string | undefined,
    timeoutMs: number,
  ): Promise<JsonResponse> {
    const url = new URL(rawUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.deps.adminToken}`,
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    return new Promise<JsonResponse>((resolve, reject) => {
      const req = transport(
        {
          host: url.hostname,
          port,
          method,
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`${method} ${url.pathname} timed out`));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private log(line: string): void {
    this.deps.logger?.(line);
  }
}
