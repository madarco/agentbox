import { postRpcAwait } from './relay-rpc.js';
import { listToolLinks, syncToolLinks } from './tool-links.js';

/**
 * Keeps the box's per-tool shim symlinks in sync with the host's grant list.
 *
 * Polls `tool.list` rather than listening for a push: the RPC is the one
 * channel every provider already has (docker forwards it, cloud parks it on
 * the host-action queue), so this needs no new event type and no
 * provider-specific plumbing. The call is cheap — the host reads two small
 * yaml files.
 *
 * Failures are silent by design: a box whose relay is briefly unreachable
 * should keep the links it already has, not tear them down.
 */

// Slow on purpose. This is a reconciler for grants changed out-of-band
// (`agentbox tools add/rm` on the host); the path that actually needs to be
// instant — an approved in-box `tool request` — re-links itself in
// `commands/tool.ts`. Every tick costs a host action on the cloud providers,
// so there is no reason to be chatty.
const DEFAULT_INTERVAL_MS = 60_000;

export interface ToolLinksWatcherOptions {
  intervalMs?: number;
  /** Container path used to resolve which project's grants apply. */
  cwd?: string;
  onChange?: (added: string[], removed: string[], conflicts: string[]) => void;
}

interface ToolListPayload {
  tools?: { name?: unknown; bin?: unknown }[];
}

export class ToolLinksWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly cwd: string;
  private readonly onChange: ToolLinksWatcherOptions['onChange'];
  private lastSignature = '';

  constructor(opts: ToolLinksWatcherOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.cwd = opts.cwd ?? '/workspace';
    this.onChange = opts.onChange;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
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
      if (res.exitCode !== 0) return;
      const names = parseToolNames(res.stdout);
      if (names === null) return;
      const signature = names.join(',');
      if (signature === this.lastSignature) return;
      const result = await syncToolLinks(names, { prunable });
      this.lastSignature = signature;
      if (result.added.length || result.removed.length || result.conflicts.length) {
        this.onChange?.(result.added, result.removed, result.conflicts);
      }
    } catch {
      // Keep whatever links exist; try again on the next tick.
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
