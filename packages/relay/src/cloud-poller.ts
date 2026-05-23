/**
 * `CloudBoxPoller` — host-resident loop that drains a cloud box's in-sandbox
 * relay over its Daytona preview URL. One poller per cloud box, owned by the
 * host relay process (so status / autopause behave the same whether or not a
 * CLI is attached, matching the Docker model).
 *
 * v0 responsibility: pull `/bridge/poll`, forward events + status into the
 * host relay's stores. Executing drained `HostAction`s (real `git push` on
 * the host, with `askPrompt` gating) and posting results back is the next
 * layer, tracked alongside Phase 4's host-RPC execution.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  BridgeActionResultBody,
  BridgePollResponse,
  HostAction,
  HostActionResult,
  RelayEvent,
} from './types.js';

export interface CloudBoxPollerDeps {
  boxId: string;
  /** Preview URL of the in-sandbox relay's `/bridge/*` surface. */
  previewUrl: string;
  /** Bearer for `/bridge/*` auth (Daytona's `x-daytona-preview-token` is added separately when known). */
  bridgeToken: string;
  /** Optional Daytona preview token header for the proxy layer. */
  previewToken?: string;
  /** Fired for each batch of new events drained from the box. */
  onEvents?: (events: RelayEvent[]) => void;
  /** Fired when a new box-status snapshot is observed. */
  onStatus?: (status: unknown) => void;
  /**
   * Fired for each parked host action the box wants the host to execute.
   * The `respond` callback POSTs back to `/bridge/action-result` and
   * unblocks the in-box `/rpc` caller — the handler MUST call it (with a
   * non-zero exitCode and stderr message even when the host can't execute
   * the action) so the box never hangs.
   */
  onAction?: (
    action: HostAction,
    respond: (result: HostActionResult) => Promise<void>,
  ) => Promise<void> | void;
  logger?: (line: string) => void;
}

const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 25_000;
const STOPPED_TICK_MS = 250;

export class CloudBoxPoller {
  private stopped = false;
  private cursor = 0;
  private currentBackoffMs = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly deps: CloudBoxPollerDeps) {}

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.run().catch((err) => {
      this.log(`poller crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopPromise) await this.loopPromise;
  }

  /**
   * Post a `HostActionResult` back to the in-sandbox relay's
   * `/bridge/action-result`. The matching parked `/rpc` Promise resolves
   * and the in-box agent finally sees the answer.
   */
  async respond(actionId: string, result: HostActionResult): Promise<void> {
    const base = this.deps.previewUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/bridge/action-result`);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;
    const body: BridgeActionResultBody = {
      id: actionId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    const payload = JSON.stringify(body);
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
        Authorization: `Bearer ${this.deps.bridgeToken}`,
      };
      if (this.deps.previewToken) {
        headers['x-daytona-preview-token'] = this.deps.previewToken;
      }
      const req = transport(
        {
          host: url.hostname,
          port,
          method: 'POST',
          path: url.pathname,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) resolve();
          else reject(new Error(`bridge/action-result → ${String(res.statusCode)}`));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('bridge/action-result timeout'));
      });
      req.write(payload);
      req.end();
    });
  }

  private log(line: string): void {
    this.deps.logger?.(`[cloud-poller ${this.deps.boxId}] ${line}`);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const body = await this.pollOnce();
        this.currentBackoffMs = 0;
        if (body.events.length > 0) this.deps.onEvents?.(body.events);
        if (body.status != null) this.deps.onStatus?.(body.status);
        for (const action of body.actions) {
          // Fire-and-forget — the action executor either runs inline (v0) or
          // hands the action to its own queue (Phase 4 executor). Failures
          // there are not the poller's concern (but they MUST still respond
          // so the in-box RPC unblocks, hence the fallback below).
          try {
            const respond = (r: HostActionResult): Promise<void> => this.respond(action.id, r);
            if (this.deps.onAction) {
              await this.deps.onAction(action, respond);
            } else {
              await respond({
                exitCode: 1,
                stdout: '',
                stderr: `host has no executor for action '${action.method}'\n`,
              });
            }
          } catch (err) {
            this.log(`action handler error: ${err instanceof Error ? err.message : String(err)}`);
            // Best-effort: tell the box we failed so its /rpc unblocks.
            try {
              await this.respond(action.id, {
                exitCode: 1,
                stdout: '',
                stderr: `host action handler crashed: ${err instanceof Error ? err.message : String(err)}\n`,
              });
            } catch {
              // ignore
            }
          }
        }
        if (typeof body.cursor === 'number' && body.cursor > this.cursor) {
          this.cursor = body.cursor;
        }
      } catch (err) {
        this.log(`poll error: ${err instanceof Error ? err.message : String(err)}`);
        await this.backoff();
      }
      // Tight loop only when we got something fresh — otherwise yield briefly
      // so we don't spin under a misbehaving preview proxy.
      if (this.currentBackoffMs === 0) await delay(STOPPED_TICK_MS);
    }
  }

  private async backoff(): Promise<void> {
    this.currentBackoffMs =
      this.currentBackoffMs === 0
        ? BACKOFF_BASE_MS
        : Math.min(this.currentBackoffMs * 2, BACKOFF_MAX_MS);
    await delay(this.currentBackoffMs);
  }

  private async pollOnce(): Promise<BridgePollResponse> {
    const base = this.deps.previewUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/bridge/poll?since=${String(this.cursor)}`);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? httpsRequest : httpRequest;
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

    return new Promise<BridgePollResponse>((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.deps.bridgeToken}`,
        Accept: 'application/json',
      };
      if (this.deps.previewToken) {
        headers['x-daytona-preview-token'] = this.deps.previewToken;
      }
      const req = transport(
        {
          host: url.hostname,
          port,
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (status < 200 || status >= 300) {
              reject(new Error(`bridge/poll → ${String(status)}: ${text.slice(0, 200)}`));
              return;
            }
            try {
              const parsed = JSON.parse(text) as Partial<BridgePollResponse>;
              resolve({
                actions: Array.isArray(parsed.actions) ? (parsed.actions as HostAction[]) : [],
                events: Array.isArray(parsed.events) ? (parsed.events as RelayEvent[]) : [],
                status: parsed.status ?? null,
                cursor: typeof parsed.cursor === 'number' ? parsed.cursor : this.cursor,
              });
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('bridge/poll timeout'));
      });
      req.end();
    });
  }
}

/**
 * Lifecycle helper: keep one poller per cloud box, start on register, stop on
 * forget. The host relay's `BoxRegistry` knows nothing about pollers; this
 * type sits alongside it.
 */
export class CloudBoxPollers {
  private readonly map = new Map<string, CloudBoxPoller>();

  /** Idempotent: replacing an existing poller for a box stops the old one first. */
  start(boxId: string, deps: CloudBoxPollerDeps): void {
    const existing = this.map.get(boxId);
    if (existing) {
      void existing.stop();
    }
    const poller = new CloudBoxPoller(deps);
    this.map.set(boxId, poller);
    poller.start();
  }

  async stop(boxId: string): Promise<void> {
    const p = this.map.get(boxId);
    if (!p) return;
    this.map.delete(boxId);
    await p.stop();
  }

  async stopAll(): Promise<void> {
    const ps = [...this.map.values()];
    this.map.clear();
    await Promise.all(ps.map((p) => p.stop()));
  }

  size(): number {
    return this.map.size;
  }
}
