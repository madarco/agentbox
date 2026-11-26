'use client';

// The Dashboard's two reads beyond the store: the week from
// GET /api/v1/usage/stats and the last two days of the activity ledger from
// GET /api/v1/activity. Pure REST client; refreshed every minute while the tab
// is visible. Either can fail on its own (an older hub, a hub with the ledger
// off) and the cards that need it say so instead of drawing zeros.

import type { UsageStats } from '@agentbox/usage-view';
import { useCallback, useEffect, useState } from 'react';
import type { DashActivity } from '@/lib/dashboard-view';

const REFRESH_MS = 60_000;

export interface Loaded<T> {
  data: T | null;
  error: string | null;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin' });
  const body = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(body.error?.message ?? `request failed (${String(r.status)})`);
  return body;
}

const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useDashboardData(): {
  stats: Loaded<UsageStats>;
  activity: Loaded<DashActivity[]>;
  /** When the activity was read: the lanes' "now". */
  readAt: number;
} {
  const [stats, setStats] = useState<Loaded<UsageStats>>({ data: null, error: null });
  const [activity, setActivity] = useState<Loaded<DashActivity[]>>({ data: null, error: null });
  const [readAt, setReadAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    const tz = browserZone();
    const q = new URLSearchParams({ range: '7d', since: '7d', tz });
    const [s, a] = await Promise.allSettled([
      getJson<UsageStats>(`/api/v1/usage/stats?${q.toString()}`),
      // 48 h back so the lanes know the state the 12 h window opens in.
      getJson<{ events: DashActivity[] }>('/api/v1/activity?since=48h&order=desc&limit=2000'),
    ]);
    setStats(
      s.status === 'fulfilled'
        ? { data: s.value, error: null }
        : (prev) => ({ data: prev.data, error: fail(s.reason) }),
    );
    setActivity(
      a.status === 'fulfilled'
        ? { data: a.value.events, error: null }
        : (prev) => ({ data: prev.data, error: fail(a.reason) }),
    );
    setReadAt(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  return { stats, activity, readAt };
}
