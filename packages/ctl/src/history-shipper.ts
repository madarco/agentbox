/**
 * The in-box history shipper (docs/agent-history-plan.md, Phase 1): tails the
 * sessions this box's binding log names and ships them to the hub over the
 * existing relay channel (`history.chunk` RPCs; the cloud poller drains them on
 * a cloud box). Docker boxes are shipped host-side by the relay instead, which
 * `history.config` tells us by answering `enabled: false`.
 */
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  HistoryShipper,
  createRedactor,
  parseBindingLog,
  secretValuesFromEnv,
  secretValuesFromJson,
  type HistoryConfigReply,
  type HistoryFileSource,
  type HistoryFrame,
  type HistoryIngestResult,
  type ShipStats,
} from '@agentbox/core';
import { postRpcAwait } from './relay-rpc.js';
import { resolveRelayEnv } from './relay-env.js';
import { HISTORY_BINDINGS_PATH } from './session-pointer.js';

/** Raw frame cap: base64 of this plus the JSON envelope stays under the relay's 1 MiB `/rpc` cap. */
export const CTL_FRAME_MAX = 512 * 1024;
const RPC_TIMEOUT_MS = 60_000;

class RpcTimeout extends Error {}

async function rpc(method: string, params: unknown): Promise<{ exitCode: number; stdout: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcTimeout(`${method} timed out`)), RPC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([postRpcAwait(method, params, { quiet: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHistoryConfig(): Promise<HistoryConfigReply | null> {
  const r = await rpc('history.config', {});
  if (r.exitCode !== 0) return null;
  try {
    const v = JSON.parse(r.stdout) as Partial<HistoryConfigReply>;
    if (typeof v.enabled !== 'boolean') return null;
    return {
      enabled: v.enabled,
      ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
      agents: Array.isArray(v.agents) ? v.agents : [],
      credentialFiles: Array.isArray(v.credentialFiles)
        ? v.credentialFiles.filter((p): p is string => typeof p === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

export const rpcHistorySink = {
  async ingest(frame: HistoryFrame): Promise<HistoryIngestResult> {
    const r = await rpc('history.chunk', frame);
    if (r.exitCode !== 0) {
      return {
        ok: false,
        code: 'unavailable',
        message: `relay answered exit ${String(r.exitCode)}`,
      };
    }
    try {
      return JSON.parse(r.stdout) as HistoryIngestResult;
    } catch {
      return { ok: false, code: 'unavailable', message: 'unparseable relay reply' };
    }
  },
};

export const localFileSource: HistoryFileSource = {
  async readBindings() {
    try {
      return parseBindingLog(await readFile(HISTORY_BINDINGS_PATH, 'utf8'));
    } catch {
      return [];
    }
  },
  async size(path) {
    try {
      const s = await stat(path);
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  },
  async read(path, offset, length) {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
  async list(dir) {
    try {
      return await readdir(dir);
    } catch {
      return null;
    }
  },
};

async function boxSecrets(credentialFiles: readonly string[]): Promise<string[]> {
  const out = secretValuesFromEnv(process.env);
  const { token } = resolveRelayEnv();
  if (token) out.push(token);
  for (const p of credentialFiles) {
    try {
      out.push(...secretValuesFromJson(await readFile(p.replace(/^~(?=\/)/, homedir()), 'utf8')));
    } catch {
      /* no such file in this box */
    }
  }
  return out;
}

export async function buildShipper(cfg: HistoryConfigReply): Promise<HistoryShipper> {
  return new HistoryShipper({
    // The relay replaces the box id from the box's own token; this is a hint.
    origin: { boxId: process.env.AGENTBOX_BOX_ID ?? '' },
    agents: cfg.agents,
    source: localFileSource,
    sink: rpcHistorySink,
    redactor: createRedactor({ secrets: await boxSecrets(cfg.credentialFiles ?? []) }),
    frameMax: CTL_FRAME_MAX,
  });
}

/**
 * The daemon's loop. Never blocks startup and never throws. With the host
 * unreachable an RPC parks on the in-box relay with no timeout of its own, so
 * a timed-out pass backs off (up to 10 min) instead of stacking more parked
 * actions every tick.
 */
export class HistoryLoop {
  private timer: NodeJS.Timeout | null = null;
  private shipper: HistoryShipper | null = null;
  private configAt = 0;
  private delayMs: number;
  private stopped = false;

  constructor(
    private readonly opts: {
      intervalMs?: number;
      log?: (line: string) => void;
    } = {},
  ) {
    this.delayMs = opts.intervalMs ?? 30_000;
  }

  start(firstDelayMs = 20_000): void {
    this.schedule(firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  async tick(final = false): Promise<ShipStats | null> {
    const base = this.opts.intervalMs ?? 30_000;
    let stats: ShipStats | null = null;
    try {
      // A disabled answer (a docker box, an opted-out project) is cached like an
      // enabled one, so it is asked again every 10 min rather than every tick.
      const stale = Date.now() - this.configAt > 10 * 60_000;
      if (stale || (this.shipper?.isDisabled ?? false)) {
        const cfg = await fetchHistoryConfig();
        // An unanswered fetch (hub not up yet) is retried next tick.
        if (cfg) this.configAt = Date.now();
        this.shipper = cfg?.enabled ? await buildShipper(cfg) : null;
      }
      if (this.shipper) stats = await this.shipper.pass({ final });
      const timedOut = stats?.errors.some((e) => e.includes('timed out')) ?? false;
      this.delayMs = timedOut ? Math.min(this.delayMs * 2, 10 * 60_000) : base;
    } catch (e) {
      if (e instanceof RpcTimeout) this.delayMs = Math.min(this.delayMs * 2, 10 * 60_000);
      this.opts.log?.(`history: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!final) this.schedule(this.delayMs);
    return stats;
  }
}
