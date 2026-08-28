import { postRpcAwait } from './relay-rpc.js';
import { listToolLinks, syncToolLinks } from './tool-links.js';

/**
 * Keeps the box's per-tool shim symlinks in sync with the host's grant list.
 *
 * Reconciles ONCE at daemon start and then waits to be told. It used to poll
 * every 60s because the RPC was "the one channel every provider already has" —
 * but `Provider.exec` is a required interface method, so the host can simply run
 * `agentbox-ctl tool relink` in the box when a grant changes. Being told beats
 * asking: instant instead of up-to-a-minute, and on a control box every tick was
 * a WAN round trip per box per minute.
 *
 * What the startup reconcile covers is exactly what a push cannot: a box that was
 * paused or stopped when the grant changed, and a box created afterwards.
 *
 * Failures are silent by design: a box whose relay is briefly unreachable should
 * keep the links it already has, not tear them down.
 */

/** Ceiling for the startup retry backoff (see {@link ToolLinksWatcher.scheduleRetry}). */
const RETRY_CEILING_MS = 60_000;

export interface ToolLinksWatcherOptions {
  /** Ceiling for the startup retry backoff. Tests shorten it. */
  retryCeilingMs?: number;
  /** Container path used to resolve which project's grants apply. */
  cwd?: string;
  onChange?: (added: string[], removed: string[], conflicts: string[]) => void;
}

interface ToolListPayload {
  tools?: { name?: unknown; bin?: unknown }[];
}

export class ToolLinksWatcher {
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private running = false;
  private failures = 0;
  private readonly retryCeilingMs: number;
  /** True between start() and stop(); gates the startup retry timer. */
  private active = false;
  private readonly cwd: string;
  private readonly onChange: ToolLinksWatcherOptions['onChange'];
  private lastSignature = '';

  constructor(opts: ToolLinksWatcherOptions = {}) {
    this.retryCeilingMs = opts.retryCeilingMs ?? RETRY_CEILING_MS;
    this.cwd = opts.cwd ?? '/workspace';
    this.onChange = opts.onChange;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.tick();
  }

  stop(): void {
    this.active = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Re-sync now, whatever the last result was — the entry point the host pushes
   * to via `agentbox-ctl tool relink`.
   *
   * Clears the cached signature first: a push means "something changed", and the
   * skip-if-identical shortcut would otherwise ignore a link a user deleted by
   * hand, or one this box failed to create last time.
   */
  async relink(): Promise<void> {
    this.lastSignature = '';
    await this.tick();
  }

  /**
   * A reconcile that couldn't reach the relay retries on a short backoff. This
   * is the startup case and it is the only reason a timer exists at all: the box
   * comes up, the daemon's first attempt may race the relay, and a tool granted
   * before the box existed must not stay missing. Reset by any success.
   */
  private scheduleRetry(): void {
    if (!this.active || this.retryTimer) return;
    this.failures += 1;
    const delay = Math.min(1_000 * 2 ** (this.failures - 1), this.retryCeilingMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tick();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Exposed so `tool request` can refresh links the moment it is approved. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Snapshot BEFORE asking, so a link created while the RPC is in flight
      // (an approved `tool request` re-linking itself) is never pruned by
      // this tick's now-stale list.
      const prunable = await listToolLinks();
      const res = await postRpcAwait(
        'tool.list',
        { path: this.cwd, format: 'json' },
        { errorPrefix: 'agentbox-ctl tool-links' },
      );
      if (res.exitCode !== 0) {
        this.scheduleRetry();
        return;
      }
      const names = parseToolNames(res.stdout);
      if (names === null) {
        this.scheduleRetry();
        return;
      }
      this.failures = 0;
      const signature = names.join(',');
      if (signature === this.lastSignature) return;
      const result = await syncToolLinks(names, { prunable });
      this.lastSignature = signature;
      if (result.added.length || result.removed.length || result.conflicts.length) {
        this.onChange?.(result.added, result.removed, result.conflicts);
      }
    } catch {
      // Keep whatever links exist; retry shortly.
      this.scheduleRetry();
    } finally {
      this.running = false;
    }
  }
}

/** `null` on a payload we can't read — the caller then leaves links alone. */
export function parseToolNames(stdout: string): string[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const tools = (doc as ToolListPayload | null)?.tools;
  if (!Array.isArray(tools)) return null;
  return tools
    .map((t) => (typeof t?.name === 'string' ? t.name : null))
    .filter((n): n is string => n !== null)
    .sort();
}
