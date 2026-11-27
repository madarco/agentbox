'use client';

// Usage page, overview (usage dashboard Phase 3): the shared `UsageView` over
// GET /api/v1/usage/stats. PURE REST CLIENT. The range (`?range=`) and the
// subscription (`?subscription=`) live in the URL, so a Subscriptions card and
// the tray's header pill link straight here. Days are the browser's zone.

import '@agentbox/usage-view/usage.css';
import type { RangeId, UsageStats } from '@agentbox/usage-view';
import { UsageView } from '@agentbox/usage-view/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import {
  USAGE_RANGES,
  localDay,
  parseUsageRange,
  usageCsv,
  usageIsEmpty,
  usageStatsQuery,
} from '@/lib/usage-page';
import { ShareDialog } from './share-dialog';
import { useSubscriptionFilter } from './subscription-filter';
import { UsageHeader } from './usage-header';

const REFRESH_MS = 60_000;

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function fetchStats(q: URLSearchParams): Promise<UsageStats> {
  const r = await fetch(`/api/v1/usage/stats?${q.toString()}`, { credentials: 'same-origin' });
  const body = (await r.json().catch(() => ({}))) as UsageStats & {
    error?: { message?: string };
  };
  if (!r.ok) throw new Error(body.error?.message ?? `request failed (${String(r.status)})`);
  return body;
}

function downloadCsv(stats: UsageStats): void {
  const blob = new Blob([usageCsv(stats)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `agentbox-usage-${stats.range.since}-to-${stats.range.today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const svg = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  viewBox: '0 0 24 24',
  'aria-hidden': true,
} as const;

export function UsageDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const range = parseUsageRange(params.get('range'));
  const { subscription, setSubscription, options, unknown } = useSubscriptionFilter();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // The answer to an older query must not replace a newer one.
  const seq = useRef(0);

  const load = useCallback(async () => {
    // A subscription this hub has never heard of has nothing to show.
    if (unknown) return;
    const n = ++seq.current;
    try {
      const s = await fetchStats(usageStatsQuery(range, localDay(), browserZone(), subscription));
      if (n !== seq.current) return;
      setStats(s);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [range, subscription, unknown]);

  useEffect(() => {
    setStats(null);
    setError(null);
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const setRange = (id: RangeId): void => {
    const q = new URLSearchParams(params.toString());
    q.set('range', id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const actions = (
    <>
      <label className="select">
        <svg {...svg}>
          <rect x="4" y="7" width="16" height="12" rx="2" />
          <path d="M9 7V5h6v2" />
        </svg>
        <select
          aria-label="Subscription"
          value={subscription ?? ''}
          onChange={(ev) => setSubscription(ev.target.value || undefined)}
        >
          <option value="">All subscriptions</option>
          {options.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn"
        disabled={!stats}
        onClick={() => stats && downloadCsv(stats)}
      >
        <svg {...svg}>
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
        Export CSV
      </button>
    </>
  );
  const header = (
    <div className="mx-auto w-full max-w-[1240px] px-6 pt-7 max-sm:px-4 max-sm:pt-5">
      <UsageHeader
        view="work"
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={!stats || usageIsEmpty(stats)}
            onClick={() => setSharing(true)}
          >
            <Icons.share />
            Share
          </Button>
        }
      />
    </div>
  );

  const message = unknown
    ? {
        title: 'Unknown subscription.',
        body: `${subscription ?? ''} is not an account on this hub and has no recorded usage.`,
      }
    : error && !stats
      ? { title: 'Couldn’t load usage.', body: error }
      : stats && usageIsEmpty(stats)
        ? {
            title: 'No recorded work in this window yet.',
            body: 'Agent hours, pushes and merged pull requests appear here once a box’s agent has run a turn.',
          }
        : null;

  if (!stats || message) {
    return (
      <>
        {header}
        <div className="usage untitled">
          <StateHead range={range} onRangeChange={setRange} actions={actions} />
          {message ? (
            <div className="state" role={error ? 'alert' : undefined}>
              <b>{message.title}</b>
              <span className={error && !unknown ? 'err' : undefined}>{message.body}</span>
            </div>
          ) : (
            <div className="state" aria-busy="true">
              <span>Loading usage…</span>
            </div>
          )}
        </div>
      </>
    );
  }
  // A failed refresh keeps the numbers already on screen and says so.
  const footer = error
    ? `Couldn’t refresh (${error}). Showing the numbers from ${new Date(stats.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    : undefined;
  return (
    <>
      {header}
      <UsageView
        data={stats}
        onRangeChange={setRange}
        actions={actions}
        footer={footer}
        title={false}
      />
      {sharing && (
        <ShareDialog
          range={range}
          tz={browserZone()}
          subscription={subscription}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  );
}

/** The view's controls row, for the loading, empty and error states. */
const RANGE_LABELS: Record<RangeId, string> = {
  '7d': '7 days',
  '30d': '30 days',
  month: 'This month',
  '90d': '90 days',
  year: 'Year',
};

function StateHead({
  range,
  onRangeChange,
  actions,
}: {
  range: RangeId;
  onRangeChange: (id: RangeId) => void;
  actions: ReactNode;
}) {
  return (
    <div className="head">
      <div className="controls">
        <div className="seg" role="group" aria-label="Range">
          {USAGE_RANGES.map((id) => (
            <button
              key={id}
              type="button"
              className={id === range ? 'on' : undefined}
              aria-pressed={id === range}
              onClick={() => onRangeChange(id)}
            >
              {RANGE_LABELS[id]}
            </button>
          ))}
        </div>
        {actions}
      </div>
    </div>
  );
}
