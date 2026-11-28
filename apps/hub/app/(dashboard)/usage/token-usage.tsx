'use client';

// Usage page, token view (`/usage?view=tokens`): tokens spent by every recorded
// agent session (agent-history Phase 7). PURE REST CLIENT over GET /api/v1/usage: one request per view
// (per-day by agent, and one per breakdown), all with the same window and
// filters. A breakdown row click adds its key as a filter. The subscription
// filter (`agent/account`) lives in the URL (`?subscription=claude/personal`)
// so a Subscriptions card links here. No cost: prices are not modelled yet.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { EmptyBox } from '../boxes/components/empty-box';
import { SectionLabel } from '../boxes/components/section-label';
import { usageKeyLabel, type SubscriptionAccount } from '@/lib/subscriptions';
import { useSubscriptionFilter } from './subscription-filter';
import { UsageHeader } from './usage-header';

type Dim = 'day' | 'agent' | 'account' | 'box' | 'project' | 'host' | 'model' | 'session';
type FilterDim = Exclude<Dim, 'day' | 'session'>;

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  messages: number;
  sessions: number;
}
interface Group extends Totals {
  keys: Partial<Record<Dim, string | null>>;
  labels: Partial<Record<Dim, string | null>>;
}
interface Report {
  totals: Totals;
  groups: Group[];
  truncated: boolean;
}

const RANGES = [
  { id: '1d', label: '24 h', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All', days: 0 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const BREAKDOWNS: Array<{ dim: Dim; title: string; filter?: FilterDim }> = [
  { dim: 'agent', title: 'By agent', filter: 'agent' },
  { dim: 'model', title: 'By model', filter: 'model' },
  { dim: 'account', title: 'By subscription', filter: 'account' },
  { dim: 'project', title: 'By project', filter: 'project' },
  { dim: 'box', title: 'By box', filter: 'box' },
  { dim: 'host', title: 'By PC', filter: 'host' },
  { dim: 'session', title: 'Top sessions' },
];

// Fixed order, so an agent keeps its colour whatever the filter shows.
const AGENT_ORDER = ['claude', 'codex', 'pi', 'opencode', 'openclaw'];
function seriesColor(agent: string, extra: string[]): string {
  const i = AGENT_ORDER.indexOf(agent);
  const slot = i >= 0 ? i : AGENT_ORDER.length + extra.indexOf(agent);
  return slot < 8 ? `var(--series-${String(slot + 1)})` : 'var(--faint)';
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function shortRepo(url: string): string {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1]! : url;
}

function keyLabel(dim: Dim, g: Group, accounts: readonly SubscriptionAccount[]): string {
  const k = g.keys[dim];
  if (k === null || k === undefined) return dim === 'box' ? 'no box (host session)' : 'unknown';
  if (dim === 'box') return g.labels.box ?? k;
  if (dim === 'account') return usageKeyLabel(k, accounts);
  if (dim === 'project') return shortRepo(k);
  if (dim === 'host') return k.slice(0, 12);
  if (dim === 'session') {
    const id = k.slice(k.indexOf(':') + 1, k.indexOf(':') + 9);
    return g.labels.session ? `${id} · ${g.labels.session}` : id;
  }
  return k;
}

function isoDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function fetchUsage(params: Record<string, string>): Promise<Report> {
  const r = await fetch(`/api/v1/usage?${new URLSearchParams(params).toString()}`, {
    credentials: 'same-origin',
  });
  const body = (await r.json().catch(() => ({}))) as Report & { error?: { message?: string } };
  if (!r.ok) throw new Error(body.error?.message ?? `request failed (${String(r.status)})`);
  return body;
}

export function TokenUsage() {
  // The subscription filter is the URL's; the other filters are page state.
  const {
    subscription,
    setSubscription,
    options: subscriptionOptions,
    accounts: known,
    unknown: unknownSubscription,
  } = useSubscriptionFilter();
  const [range, setRange] = useState<RangeId>('7d');
  const [others, setOthers] = useState<Partial<Record<FilterDim, string>>>({});
  const filters = useMemo<Partial<Record<FilterDim, string>>>(
    () => ({ ...others, ...(subscription ? { account: subscription } : {}) }),
    [others, subscription],
  );
  const [daily, setDaily] = useState<Report | null>(null);
  const [tables, setTables] = useState<Partial<Record<Dim, Report>>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const base: Record<string, string> = {
      tzOffset: String(-new Date().getTimezoneOffset()),
      ...(filters as Record<string, string>),
    };
    if (range !== 'all') base.since = range;
    try {
      const [d, ...rest] = await Promise.all([
        fetchUsage({ ...base, by: 'day,agent', limit: '1000' }),
        ...BREAKDOWNS.map((b) =>
          fetchUsage({ ...base, by: b.dim, limit: b.dim === 'session' ? '20' : '50' }),
        ),
      ]);
      setDaily(d);
      setTables(Object.fromEntries(BREAKDOWNS.map((b, i) => [b.dim, rest[i]!])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [range, filters]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const setFilter = (dim: FilterDim, value: string | undefined): void => {
    if (dim === 'account') {
      setSubscription(value);
      return;
    }
    setOthers((f) => {
      const next = { ...f };
      if (value) next[dim] = value;
      else delete next[dim];
      return next;
    });
  };
  const totals = daily?.totals;
  const days = RANGES.find((r) => r.id === range)!.days;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-6 pb-16 pt-7 max-sm:px-4 max-sm:pt-5">
      <UsageHeader view="tokens" />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Button
            key={r.id}
            size="sm"
            variant={range === r.id ? 'default' : 'outline'}
            onClick={() => setRange(r.id)}
          >
            {r.label}
          </Button>
        ))}
        <Select
          aria-label="Subscription"
          className="h-8 text-[13px]"
          value={subscription ?? ''}
          onChange={(ev) => setFilter('account', ev.target.value || undefined)}
        >
          <option value="">All subscriptions</option>
          {subscriptionOptions.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        {Object.entries(others)
          .filter(([k]) => k !== 'account')
          .map(([k, v]) => (
            <Button
              key={k}
              size="sm"
              variant="ghost"
              className="font-mono text-[12px]"
              onClick={() => setFilter(k as FilterDim, undefined)}
              title="Remove this filter"
            >
              {k}: {k === 'project' ? shortRepo(v) : v} <Icons.x />
            </Button>
          ))}
      </div>

      {error ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Couldn’t load usage.</div>
            <div className="mt-1.5 font-mono text-xs text-red-400">{error}</div>
          </EmptyBox>
        </div>
      ) : unknownSubscription ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Unknown subscription.</div>
            <div className="mt-1.5 font-mono text-xs text-muted-foreground">
              {subscription} is not an account on this hub and has no recorded usage.
            </div>
          </EmptyBox>
        </div>
      ) : !daily || !totals ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : totals.messages === 0 ? (
        <div className="mt-6">
          <EmptyBox>
            <div>No recorded usage in this window.</div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              Sessions appear here once a box&apos;s agent has run a turn.
            </div>
          </EmptyBox>
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-6 gap-3 max-lg:grid-cols-3 max-sm:grid-cols-2">
            <Tile label="Total tokens" value={totals.totalTokens} />
            <Tile label="Input" value={totals.inputTokens} />
            <Tile label="Output" value={totals.outputTokens} />
            <Tile
              label="Cache read / write"
              text={`${fmt(totals.cacheReadTokens)} / ${fmt(totals.cacheWriteTokens)}`}
              exact={`${totals.cacheReadTokens.toLocaleString()} / ${totals.cacheWriteTokens.toLocaleString()}`}
            />
            <Tile label="Responses" value={totals.messages} />
            <Tile label="Sessions" value={totals.sessions} />
          </div>

          <SectionLabel>Tokens per day</SectionLabel>
          <Card className="p-4 px-5">
            <DailyChart groups={daily.groups} days={days} />
          </Card>

          {BREAKDOWNS.map((b) => {
            const r = tables[b.dim];
            if (!r || r.groups.length === 0) return null;
            // A dimension already filtered to one value says nothing new.
            if (b.filter && filters[b.filter]) return null;
            return (
              <div key={b.dim}>
                <SectionLabel
                  right={
                    r.truncated ? (
                      <span className="normal-case tracking-normal">top {r.groups.length}</span>
                    ) : null
                  }
                >
                  {b.title}
                </SectionLabel>
                <Breakdown
                  dim={b.dim}
                  report={r}
                  accounts={known}
                  total={totals.totalTokens}
                  onPick={b.filter ? (key) => setFilter(b.filter!, key) : undefined}
                />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  text,
  exact,
}: {
  label: string;
  value?: number;
  text?: string;
  exact?: string;
}) {
  return (
    <Card className="p-4 px-5" title={exact ?? value?.toLocaleString()}>
      <div className="font-mono text-[11px] uppercase tracking-[.1em] text-[var(--faint)]">
        {label}
      </div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-[-0.02em]">
        {text ?? fmt(value ?? 0)}
      </div>
    </Card>
  );
}

function DailyChart({ groups, days }: { groups: Group[]; days: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const { dayList, agents, byDay, max } = useMemo(() => {
    const byDay = new Map<string, Map<string, number>>();
    const seen = new Set<string>();
    for (const g of groups) {
      const day = g.keys.day ?? 'unknown';
      const agent = g.keys.agent ?? 'unknown';
      seen.add(agent);
      const m = byDay.get(day) ?? new Map<string, number>();
      m.set(agent, (m.get(agent) ?? 0) + g.totalTokens);
      byDay.set(day, m);
    }
    // Every day of a bounded window gets a slot, so gaps read as zero.
    const dayList =
      days > 0
        ? Array.from({ length: days + 1 }, (_, i) => isoDay(Date.now() - (days - i) * 86_400_000))
        : [...byDay.keys()].sort();
    if (days > 0 && !byDay.has(dayList[0]!)) dayList.shift();
    const agents = [
      ...AGENT_ORDER.filter((a) => seen.has(a)),
      ...[...seen].filter((a) => !AGENT_ORDER.includes(a)).sort(),
    ];
    let max = 0;
    for (const d of dayList) {
      const sum = [...(byDay.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0);
      max = Math.max(max, sum);
    }
    return { dayList, agents, byDay, max };
  }, [groups, days]);
  const extra = agents.filter((a) => !AGENT_ORDER.includes(a));

  const W = 1000;
  const H = 220;
  const padL = 48;
  const padB = 22;
  const plotH = H - padB - 8;
  const slot = (W - padL) / Math.max(dayList.length, 1);
  const barW = Math.max(2, Math.min(36, slot * 0.7));
  const y = (v: number): number => (max > 0 ? (v / max) * plotH : 0);
  const ticks = max > 0 ? [0, max / 2, max] : [0];
  const labelEvery = Math.ceil(dayList.length / 10);
  const hovered = hover ? byDay.get(hover) : undefined;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-secondary-foreground">
        {agents.map((a) => (
          <span key={a} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-[3px]"
              style={{ background: seriesColor(a, extra) }}
            />
            {a}
          </span>
        ))}
        <button
          type="button"
          className="ml-auto text-[12px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px] tabular-nums">
            <thead className="text-left font-mono text-[11px] uppercase text-[var(--faint)]">
              <tr>
                <th className="py-1 pr-4 font-normal">Day</th>
                {agents.map((a) => (
                  <th key={a} className="py-1 pr-4 text-right font-normal">
                    {a}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dayList.map((d) => (
                <tr key={d} className="border-t border-border/60">
                  <td className="py-1 pr-4 font-mono">{d}</td>
                  {agents.map((a) => (
                    <td key={a} className="py-1 pr-4 text-right">
                      {(byDay.get(d)?.get(a) ?? 0).toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${String(W)} ${String(H)}`}
            className="h-auto w-full"
            role="img"
            aria-label="Tokens per day, stacked by agent"
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={padL}
                  x2={W}
                  y1={8 + plotH - y(t)}
                  y2={8 + plotH - y(t)}
                  stroke="currentColor"
                  className="text-border"
                  strokeWidth={1}
                />
                <text
                  x={padL - 6}
                  y={8 + plotH - y(t) + 4}
                  textAnchor="end"
                  className="fill-[var(--faint)] text-[11px]"
                >
                  {fmt(Math.round(t))}
                </text>
              </g>
            ))}
            {dayList.map((d, i) => {
              const x = padL + i * slot + (slot - barW) / 2;
              let acc = 0;
              const segs = agents.flatMap((a) => {
                const v = byDay.get(d)?.get(a) ?? 0;
                if (v <= 0) return [];
                const h = y(v);
                const top = 8 + plotH - acc - h;
                acc += h;
                // A 2px surface gap between stacked segments.
                return [
                  <rect
                    key={a}
                    x={x}
                    y={top + 1}
                    width={barW}
                    height={Math.max(h - 2, 1)}
                    rx={Math.min(4, barW / 2)}
                    fill={seriesColor(a, extra)}
                    opacity={hover && hover !== d ? 0.45 : 1}
                  />,
                ];
              });
              return (
                <g key={d}>
                  {segs}
                  <rect
                    x={padL + i * slot}
                    y={0}
                    width={slot}
                    height={H}
                    fill="transparent"
                    onMouseEnter={() => setHover(d)}
                  />
                  {i % labelEvery === 0 ? (
                    <text
                      x={x + barW / 2}
                      y={H - 6}
                      textAnchor="middle"
                      className="fill-[var(--faint)] text-[11px]"
                    >
                      {d.slice(5)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {hover ? (
            <div className="pointer-events-none absolute right-2 top-0 rounded-md border bg-popover px-3 py-2 text-[12px] shadow-sm">
              <div className="font-mono font-medium">{hover}</div>
              {agents.map((a) => {
                const v = hovered?.get(a) ?? 0;
                return v > 0 ? (
                  <div key={a} className="flex items-center gap-2 tabular-nums">
                    <span
                      className="inline-block size-2 rounded-[2px]"
                      style={{ background: seriesColor(a, extra) }}
                    />
                    <span className="flex-1 text-secondary-foreground">{a}</span>
                    <span>{v.toLocaleString()}</span>
                  </div>
                ) : null;
              })}
              {!hovered ? <div className="text-muted-foreground">no usage</div> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Breakdown({
  dim,
  report,
  accounts,
  total,
  onPick,
}: {
  dim: Dim;
  report: Report;
  accounts: readonly SubscriptionAccount[];
  total: number;
  onPick?: (key: string) => void;
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-[12.5px] tabular-nums">
        <thead className="text-left font-mono text-[11px] uppercase text-[var(--faint)]">
          <tr>
            <th className="px-5 py-2 font-normal">
              {dim === 'host' ? 'PC' : dim === 'account' ? 'subscription' : dim}
            </th>
            <th className="w-[22%] px-2 py-2 font-normal">Share</th>
            <th className="px-2 py-2 text-right font-normal">Total</th>
            <th className="px-2 py-2 text-right font-normal">Input</th>
            <th className="px-2 py-2 text-right font-normal">Output</th>
            <th className="px-2 py-2 text-right font-normal">Cache r/w</th>
            <th className="px-2 py-2 text-right font-normal">Resp.</th>
            <th className="px-5 py-2 text-right font-normal">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {report.groups.map((g, i) => {
            const key = g.keys[dim];
            const share = total > 0 ? g.totalTokens / total : 0;
            const pick = onPick && key ? () => onPick(key) : undefined;
            return (
              <tr
                key={key ?? `unknown-${String(i)}`}
                className={`border-t border-border/60 ${pick ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                onClick={pick}
                title={
                  pick
                    ? `Filter by this ${dim === 'account' ? 'subscription' : dim}`
                    : (key ?? undefined)
                }
              >
                <td className="max-w-[320px] truncate px-5 py-2 font-medium">
                  {keyLabel(dim, g, accounts)}
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${String(share * 100)}%`, background: 'var(--series-1)' }}
                      />
                    </div>
                    <span className="w-10 text-right text-muted-foreground">
                      {(share * 100).toFixed(share < 0.1 ? 1 : 0)}%
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right" title={g.totalTokens.toLocaleString()}>
                  {fmt(g.totalTokens)}
                </td>
                <td className="px-2 py-2 text-right">{fmt(g.inputTokens)}</td>
                <td className="px-2 py-2 text-right">{fmt(g.outputTokens)}</td>
                <td className="px-2 py-2 text-right">
                  {fmt(g.cacheReadTokens)} / {fmt(g.cacheWriteTokens)}
                </td>
                <td className="px-2 py-2 text-right">{g.messages}</td>
                <td className="px-5 py-2 text-right">{g.sessions}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
