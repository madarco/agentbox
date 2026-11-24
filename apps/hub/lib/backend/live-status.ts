// The live summary of each box's agents (docs/agent-live-status-plan.md,
// Phase 3): the current session's title, working-on line and tokens, derived
// from the transcripts the history pipeline already ships and parses. Nothing
// here is pushed by the box: the summary changes when a history frame of the
// box's current session is ingested, and the change notifier fires at most
// once per box every 30s, only when a value changed.
import type { HistoryLiveRow, HistoryRepo, HistoryService } from './history';
import type { AgentLiveUsage, AgentStatusWire, Box } from '../boxes/types';

export const LIVE_NOTIFY_MIN_INTERVAL_MS = 30_000;

export interface AgentLiveSummary {
  title?: string;
  activity?: string;
  usage?: AgentLiveUsage;
}

type LiveHistory = Pick<HistoryService, 'onSessionUpdated'> & {
  repo: Pick<HistoryRepo, 'getSession' | 'liveRow' | 'latestBoxSession'>;
};

export interface LiveStatusDeps {
  /** The history service, once open (it is optional on a hub). */
  history: () => LiveHistory | undefined;
  /** The hub's change notifier (SSE refetch signal). */
  notify: () => void;
  now?: () => number;
  minIntervalMs?: number;
}

/**
 * The session an agent's live summary is read from: the id the box reports
 * (`agentStatus[agent].sessionId`), else the box's most recent session of that
 * agent. The fallback covers boxes whose ctl predates `sessionId`; drop it once
 * every supported box reports one.
 */
export async function currentSessionKey(
  repo: Pick<HistoryRepo, 'latestBoxSession'>,
  boxId: string,
  agent: string,
  entry: Pick<AgentStatusWire, 'sessionId'>,
): Promise<string | null> {
  if (entry.sessionId) return `${agent}:${entry.sessionId}`;
  return repo.latestBoxSession(boxId, agent);
}

function maxTs(...ts: Array<string | null | undefined>): string | undefined {
  let best: string | undefined;
  for (const t of ts) if (t && (!best || t > best)) best = t;
  return best;
}

/** The usage block from a live row: the agent's own totals when it keeps them, else the sum. */
export function liveUsage(row: HistoryLiveRow): AgentLiveUsage | undefined {
  const base = row.totals ?? row.sums;
  if (!base) return undefined;
  const cost = row.totals ? row.totals.costUsd : (row.sums?.costUsd ?? undefined);
  const updatedAt =
    maxTs(row.totals?.ts, row.sums?.ts) ??
    (row.updatedAt > 0 ? new Date(row.updatedAt).toISOString() : undefined);
  if (!updatedAt) return undefined;
  return {
    input: base.input,
    output: base.output,
    cacheRead: base.cacheRead,
    cacheWrite: base.cacheWrite,
    ...(row.totals?.reasoning ? { reasoning: row.totals.reasoning } : {}),
    ...(row.contextTokens !== null ? { contextTokens: row.contextTokens } : {}),
    ...(row.contextWindow !== null ? { contextWindow: row.contextWindow } : {}),
    ...(cost !== undefined && cost !== null ? { costUsd: cost } : {}),
    updatedAt,
  };
}

export async function liveSummary(
  repo: Pick<HistoryRepo, 'getSession' | 'liveRow'>,
  sessionKey: string,
): Promise<AgentLiveSummary | null> {
  const [session, row] = await Promise.all([repo.getSession(sessionKey), repo.liveRow(sessionKey)]);
  if (!session && !row) return null;
  const activity = row?.plan ?? row?.activity ?? undefined;
  const usage = row ? liveUsage(row) : undefined;
  return {
    ...(session?.title ? { title: session.title } : {}),
    ...(activity ? { activity } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** What a change of the summary is judged on; `updatedAt` alone is not a change. */
function fingerprint(s: AgentLiveSummary | null): string {
  if (!s) return '';
  const usage = s.usage ? { ...s.usage, updatedAt: '' } : null;
  return JSON.stringify([s.title ?? '', s.activity ?? '', usage]);
}

export interface LiveStatus {
  /** The box with each agent's entry enriched: derived title, activity, usage. */
  apply(box: Box): Promise<Box>;
  /** Subscribe to the history service (idempotent; a no-op until it is open). */
  start(): void;
  stop(): void;
}

export function createLiveStatus(deps: LiveStatusDeps): LiveStatus {
  const now = deps.now ?? Date.now;
  const minInterval = deps.minIntervalMs ?? LIVE_NOTIFY_MIN_INTERVAL_MS;
  /** `box\0agent` -> the session key the last listing resolved as current. */
  const current = new Map<string, string>();
  /** session key -> fingerprint of the summary last seen. */
  const seen = new Map<string, string>();
  const lastNotify = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();
  let unsubscribe: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();

  const fire = (boxId: string): void => {
    lastNotify.set(boxId, now());
    deps.notify();
  };

  const schedule = (boxId: string): void => {
    if (timers.has(boxId)) return;
    const wait = (lastNotify.get(boxId) ?? -Infinity) + minInterval - now();
    if (wait <= 0) {
      fire(boxId);
      return;
    }
    const t = setTimeout(() => {
      timers.delete(boxId);
      fire(boxId);
    }, wait);
    t.unref?.();
    timers.set(boxId, t);
  };

  const onUpdated = async (sessionKey: string, boxId: string | null): Promise<void> => {
    if (!boxId) return;
    const h = deps.history();
    if (!h) return;
    const agent = sessionKey.slice(0, sessionKey.indexOf(':'));
    // Before any listing resolved it, any session of the box may be current.
    const cur = current.get(`${boxId}\0${agent}`);
    if (cur && cur !== sessionKey) return;
    const fp = fingerprint(await liveSummary(h.repo, sessionKey));
    if (seen.get(sessionKey) === fp) return;
    seen.set(sessionKey, fp);
    schedule(boxId);
  };

  return {
    async apply(box) {
      const h = deps.history();
      const entries = box.agentStatus;
      if (!h || !entries) return box;
      const next: Record<string, AgentStatusWire> = {};
      const titles: Record<string, { from?: string; to: string }> = {};
      for (const [agent, entry] of Object.entries(entries)) {
        let key: string | null = null;
        let summary: AgentLiveSummary | null = null;
        try {
          key = await currentSessionKey(h.repo, box.id, agent, entry);
          summary = key ? await liveSummary(h.repo, key) : null;
        } catch {
          summary = null;
        }
        if (key) {
          current.set(`${box.id}\0${agent}`, key);
          // Seed the change baseline, so the first ingest after a listing
          // fires only when it moved something.
          if (!seen.has(key)) seen.set(key, fingerprint(summary));
        }
        if (summary?.title && summary.title !== entry.sessionTitle) {
          titles[agent] = {
            ...(entry.sessionTitle ? { from: entry.sessionTitle } : {}),
            to: summary.title,
          };
        }
        next[agent] = {
          ...entry,
          ...(summary?.title ? { sessionTitle: summary.title } : {}),
          ...(summary?.activity ? { activity: summary.activity } : {}),
          ...(summary?.usage ? { usage: summary.usage } : {}),
        };
      }
      const out: Box = { ...box, agentStatus: next };
      // The named title fields are the same value, for clients that read them.
      if (titles.claude) out.claudeSessionTitle = titles.claude.to;
      if (titles.codex) out.codexSessionTitle = titles.codex.to;
      if (titles.opencode) out.opencodeSessionTitle = titles.opencode.to;
      // The box label falls back to the session title: follow the derived one.
      if (!box.displayName) {
        const moved = Object.values(titles).find((t) => t.from === box.task);
        if (moved) out.task = moved.to;
        else if (box.task === box.name) {
          const first = Object.values(titles)[0];
          if (first) out.task = first.to;
        }
      }
      return out;
    },

    start() {
      if (unsubscribe) return;
      const h = deps.history();
      if (!h) return;
      unsubscribe = h.onSessionUpdated((key, boxId) => {
        // One at a time: two frames of one session must not race the baseline.
        chain = chain.then(() => onUpdated(key, boxId)).catch(() => undefined);
      });
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
