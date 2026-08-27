/**
 * `HostReachPoller` — the PC-resident loop that drains host actions parked on a
 * control box (`/admin/hostreach/*`) and executes them against the real project
 * files on this machine.
 *
 * The counterpart to {@link CloudBoxPoller}, and deliberately shaped like it:
 * long-poll, execute, post the result back, back off on failure. The difference
 * is direction — that one reaches *into* a box, this one reaches *out* to the
 * control box, because a laptop behind NAT can't be dialled.
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
  execute: (action: HostAction) => Promise<HostActionResult>;
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

  constructor(private readonly deps: HostReachPollerDeps) {}

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.run().catch((err: unknown) => {
      this.log(`host-reach poller crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopPromise) await this.loopPromise;
  }

  private async run(): Promise<void> {
    const base = this.deps.controlPlaneUrl.replace(/\/+$/, '');
    this.log(`host-reach: polling ${base} for host actions`);
    while (!this.stopped) {
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
        this.maybeDrainOutbox();
        const parsed = JSON.parse(res.text.length > 0 ? res.text : '{}') as {
          actions?: HostAction[];
        };
        const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
        // Sequential on purpose: each action can open a confirm prompt on this
        // machine, and two prompts racing for one terminal is not a UX.
        for (const action of actions) {
          if (this.stopped) break;
          await this.handle(base, action);
        }
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

  private async handle(base: string, action: HostAction): Promise<void> {
    this.log(`host-reach: executing ${action.method} for box ${action.boxId}`);
    let result: HostActionResult;
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
      await this.post(`${base}/admin/hostreach/result`, { id: action.id, ...result });
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
