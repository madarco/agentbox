/**
 * Where a timeline row is written, and which workspace a box belongs to.
 *
 * The store lives on the hub that owns the boxes. On a plain laptop that is the
 * local hub and both answers come off this disk; with a control box configured,
 * the workspaces, tasks and log are THERE, and a row this machine produces (a
 * docker box's push, a queue worker's `box.ready`) has to travel to it or it is
 * dropped — there is no workspace here to record it in.
 *
 * Every writer that runs after its real work has already succeeded goes through
 * this seam, so the local-vs-remote choice is made once, at process start, and
 * never at a call site. The remote implementation is best-effort by
 * construction: it never throws, and a failed forward costs one warning line.
 */
import { hostname } from 'node:os';
import { resolveControlBox, type ControlBoxTarget } from './control-box.js';
import {
  readWorkspaceForBox,
  recordTimelineEvent,
  workspaceForBoxIn,
  type TimelineEventInput,
} from './timeline-store.js';
import type { BoxWorkspaceKey } from './workspace-store.js';
import type { TimelineEvent } from './types.js';

/** All a timeline writer needs of a workspace: the id it records against. */
export interface TimelineWorkspaceRef {
  id: string;
}

export interface TimelineSink {
  /** `file` writes this machine's store; `remote` forwards to the control box. */
  readonly kind: 'file' | 'remote';
  /**
   * Append one event. `null` when the workspace is unknown, the event's `key` is
   * already in the log, or (remote) the forward did not land.
   */
  record(wsId: string, input: TimelineEventInput): Promise<TimelineEvent | null>;
  /** The workspace a box belongs to, by repo and/or (host, folder). */
  workspaceFor(key: BoxWorkspaceKey, localHost?: string): Promise<TimelineWorkspaceRef | null>;
}

export function fileTimelineSink(): TimelineSink {
  return {
    kind: 'file',
    record: (wsId, input) => recordTimelineEvent(wsId, input),
    workspaceFor: (key, localHost) => readWorkspaceForBox(key, localHost ?? hostname()),
  };
}

export interface RemoteTimelineSinkOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called once per process the first time the control box cannot be reached. */
  warn?: (message: string) => void;
  /** How long a workspace listing is reused (default 30s). */
  cacheMs?: number;
  timeoutMs?: number;
}

/** The workspace listing is re-read on this cadence; a new workspace is rare. */
const WORKSPACES_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5000;

/** The listing shape `GET /api/v1/workspaces` returns, as the join needs it. */
interface RemoteWorkspace {
  id: string;
  projects: { repoUrl?: string }[];
  hosts: Record<string, { root: string }>;
}

export function remoteTimelineSink(
  target: ControlBoxTarget,
  opts: RemoteTimelineSinkOptions = {},
): TimelineSink {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? WORKSPACES_CACHE_MS;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = target.url.replace(/\/+$/, '');
  let cache: { at: number; workspaces: RemoteWorkspace[] } | null = null;
  let warned = false;

  function warnOnce(err: unknown): void {
    if (warned) return;
    warned = true;
    opts.warn?.(
      `[timeline] could not reach the control box at ${base} to record events: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetchImpl(`${base}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function listWorkspaces(): Promise<RemoteWorkspace[]> {
    if (cache && now() - cache.at < cacheMs) return cache.workspaces;
    const res = await call('GET', '/workspaces');
    if (!res.ok) throw new Error(`GET /workspaces failed: ${String(res.status)}`);
    const body = (await res.json()) as { workspaces?: RemoteWorkspace[] };
    const workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];
    cache = { at: now(), workspaces };
    return workspaces;
  }

  return {
    kind: 'remote',
    async record(wsId, input): Promise<TimelineEvent | null> {
      try {
        const res = await call(
          'POST',
          `/workspaces/${encodeURIComponent(wsId)}/timeline/events`,
          input,
        );
        // 200 is the key having deduped it (a retried job reports once), 404 a
        // workspace this hub does not have; neither is worth a warning.
        if (res.status !== 201) {
          if (res.status >= 500) warnOnce(new Error(`POST timeline/events: ${String(res.status)}`));
          return null;
        }
        const body = (await res.json()) as { event?: TimelineEvent };
        return body.event ?? null;
      } catch (err) {
        warnOnce(err);
        return null;
      }
    },
    async workspaceFor(key, localHost): Promise<TimelineWorkspaceRef | null> {
      try {
        return await workspaceForBoxIn(await listWorkspaces(), key, localHost ?? hostname());
      } catch (err) {
        warnOnce(err);
        return null;
      }
    },
  };
}

let current: TimelineSink = fileTimelineSink();

/** The sink this process writes through. */
export function timelineSink(): TimelineSink {
  return current;
}

/** Install a sink (`null` restores the file one). Returns what is now installed. */
export function configureTimelineSink(sink: TimelineSink | null): TimelineSink {
  current = sink ?? fileTimelineSink();
  return current;
}

/**
 * Pick the sink from this machine's config: remote when a control box is
 * configured and this process is not one itself, else the file store. The one
 * selection rule, called at hub start and by the queue worker.
 */
export async function configureTimelineSinkFromConfig(
  opts: RemoteTimelineSinkOptions = {},
): Promise<TimelineSink> {
  const target = await resolveControlBox();
  return configureTimelineSink(target ? remoteTimelineSink(target, opts) : null);
}
