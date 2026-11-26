import { useEffect, useId, useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { maxOf, minOf, overlapProfile } from '../aggregate.js';
import type { AgentId, ProviderId } from '../schema.js';
import {
  AGENT_COLOR,
  DOW,
  MONTHS,
  barPath,
  barPathDown,
  dayMonth,
  dayNum,
  dow,
  fmt,
  fullDay,
  hm,
  monthIdx,
  nf,
  niceMax,
} from './format.js';
import { TipRow, useTip, useWidth } from './hooks.js';
import { AgentGlyph } from './marks.js';

const max0 = (xs: readonly number[]): number => xs.reduce((a, b) => (b > a ? b : a), 0);

// ---------------------------------------------------------------------------
// Sparkline

export function Spark({
  values,
  color,
}: {
  values: readonly number[];
  color: string;
}): ReactElement {
  const [ref, W] = useWidth<SVGSVGElement>(260);
  const H = 38;
  if (values.length < 2) return <svg ref={ref} className="spark" />;
  const max = max0(values) || 1;
  const sx = (i: number): number => 4 + (i / (values.length - 1)) * (W - 10);
  const sy = (v: number): number => H - 5 - (v / max) * (H - 12);
  const pts = values.map((v, i) => `${sx(i)},${sy(v)}`).join(' L');
  const last = values.length - 1;
  return (
    <svg ref={ref} className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <path
        d={`M${sx(0)},${H} L${pts} L${sx(last)},${H}Z`}
        style={{ fill: color }}
        fillOpacity={0.1}
      />
      <path
        d={`M${pts}`}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={sx(last)}
        cy={sy(values[last]!)}
        r={4}
        style={{ fill: color, stroke: 'var(--card)' }}
        strokeWidth={2}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Gantt: one day's boxes as lanes, with the boxes-at-once strip on top

export interface GanttLane {
  agent: AgentId;
  provider: ProviderId;
  intervals: readonly (readonly [number, number])[];
  /** The box name; null on a public share, where the lane is "agent on provider". */
  label: string | null;
  /** `repo#n` of the merged PR; null on a share even when `merged`. */
  pr: string | null;
  merged: boolean;
}

export function laneName(l: GanttLane): string {
  return l.label ?? `${l.agent} on ${l.provider}`;
}

export function ganttSummary(lanes: readonly GanttLane[]): {
  peak: number;
  hours: number;
  busy: number;
  prs: number;
} {
  const spans = lanes.flatMap((l) => l.intervals.map(([start, end]) => ({ start, end })));
  const prof = overlapProfile(spans);
  return {
    peak: max0(prof.map((p) => p.n)),
    hours: spans.reduce((a, s) => a + s.end - s.start, 0),
    busy: prof.reduce((a, p) => a + p.end - p.start, 0),
    prs: lanes.filter((l) => l.merged).length,
  };
}

export function Gantt({ lanes }: { lanes: readonly GanttLane[] }): ReactElement {
  const [ref, W] = useWidth<HTMLDivElement>(900);
  const tip = useTip();
  const narrow = W < 560;
  const LBL = narrow ? 104 : 168;
  const R = 12;
  const STRIP = 64;
  const LANE = 24;
  const AX = 22;
  const H = STRIP + 16 + lanes.length * LANE + AX;
  const spans = lanes.flatMap((l) => l.intervals.map(([start, end]) => ({ start, end })));
  const minStart = spans.length ? minOf(spans.map((s) => s.start)) : 8;
  const maxEnd = spans.length ? maxOf(spans.map((s) => s.end)) : 20;
  const T0 = Math.max(0, Math.floor(minStart / 2) * 2);
  const T1 = Math.max(T0 + 6, Math.ceil(maxEnd / 2) * 2);
  const x = (h: number): number => LBL + ((h - T0) / (T1 - T0)) * (W - LBL - R);
  const prof = overlapProfile(spans);
  const peak = max0(prof.map((p) => p.n));
  const atPeak = prof.filter((p) => p.n === peak);
  const pa = atPeak[0]?.start ?? T0;
  const pb = atPeak[atPeak.length - 1]?.end ?? T0;
  const sy = (n: number): number => STRIP - (n / Math.max(peak, 1)) * (STRIP - 14);
  const tickStep = narrow ? 4 : 2;
  const maxChars = Math.floor((LBL - 30) / 6.7);
  const cut = (s: string): string => (s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s);

  // The strip as a step line over [T0, T1], zero where nothing ran.
  let d = `M${x(T0)},${sy(0)}`;
  let t = T0;
  for (const p of prof) {
    if (p.start > t) d += `L${x(t)},${sy(0)}L${x(p.start)},${sy(0)}`;
    d += `L${x(p.start)},${sy(p.n)}L${x(p.end)},${sy(p.n)}`;
    t = p.end;
  }
  d += `L${x(t)},${sy(0)}L${x(T1)},${sy(0)}`;

  const running = (h: number): GanttLane[] =>
    lanes.filter((l) => l.intervals.some(([a, b]) => h >= a && h < b));
  const ticks: number[] = [];
  for (let h = T0; h <= T1; h += tickStep) ticks.push(h);

  return (
    <div ref={ref} className="chart-wrap">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${peak} boxes at once`}
      >
        {peak > 0 && (
          <rect
            x={x(pa)}
            y={4}
            width={Math.max(2, x(pb) - x(pa))}
            height={H - AX - 4}
            rx={4}
            style={{ fill: 'var(--green-soft)' }}
          />
        )}
        {ticks.map((h) => (
          <g key={h}>
            <line x1={x(h)} x2={x(h)} y1={STRIP + 8} y2={H - AX} className="grid-line" />
            <text x={x(h)} y={H - 6} textAnchor={h === T1 ? 'end' : 'middle'}>
              {String(h % 24).padStart(2, '0')}:00
            </text>
          </g>
        ))}
        <path d={d + 'Z'} style={{ fill: 'var(--w3)' }} fillOpacity={0.14} />
        <path
          d={d}
          fill="none"
          style={{ stroke: 'var(--w4)' }}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <line x1={LBL} x2={W - R} y1={STRIP} y2={STRIP} className="axis-line" />
        <text x={LBL - 10} y={sy(peak) + 4} textAnchor="end">
          {peak}
        </text>
        <text x={LBL - 10} y={STRIP + 4} textAnchor="end">
          0
        </text>
        <text x={0} y={STRIP / 2 + 4} className="strong-label">
          {narrow ? 'At once' : 'Boxes at once'}
        </text>
        {peak > 0 && (
          <text x={(x(pa) + x(pb)) / 2} y={sy(peak) - 6} textAnchor="middle" className="peak-label">
            {peak} at once · {hm(pa)}
          </text>
        )}
        <rect
          x={LBL}
          y={0}
          width={Math.max(0, W - LBL - R)}
          height={STRIP}
          fill="transparent"
          onMouseMove={(ev) => {
            const r = (
              ev.currentTarget.ownerSVGElement ?? ev.currentTarget
            ).getBoundingClientRect();
            const h = T0 + ((ev.clientX - r.left - LBL) / (W - LBL - R)) * (T1 - T0);
            const on = running(h);
            tip.show(
              <>
                <div className="t">
                  {hm(h)} · {on.length} running
                </div>
                {on.map((l, i) => (
                  <div key={i} className="r muted">
                    {laneName(l)}
                  </div>
                ))}
              </>,
              ev,
            );
          }}
          onMouseLeave={tip.hide}
        />
        {lanes.map((l, i) => {
          const cy = STRIP + 16 + i * LANE + LANE / 2;
          const color = AGENT_COLOR[l.agent];
          const segs = l.intervals;
          const end = segs[segs.length - 1]?.[1] ?? T0;
          return (
            <g key={i}>
              <AgentGlyph agent={l.agent} x={0} y={cy - 8} size={16} />
              <text x={24} y={cy + 4} className="lane-label">
                <title>{laneName(l)}</title>
                {cut(laneName(l))}
              </text>
              {segs.length > 1 && (
                <line
                  x1={x(segs[0]![0])}
                  x2={x(end)}
                  y1={cy}
                  y2={cy}
                  style={{ stroke: 'var(--line)' }}
                  strokeWidth={2}
                  strokeDasharray="2 3"
                />
              )}
              {segs.map(([a, b], si) => (
                <rect
                  key={si}
                  x={x(a)}
                  y={cy - 7}
                  width={Math.max(3, x(b) - x(a))}
                  height={14}
                  rx={4}
                  className="u-grow-x"
                  style={{ fill: color, animationDelay: `${i * 40}ms` }}
                  onMouseMove={(ev) =>
                    tip.show(
                      <>
                        <div className="t">{laneName(l)}</div>
                        <TipRow color={color} label={l.agent} value={l.provider} />
                        <div className="r muted">
                          {hm(a)} – {hm(b)}
                          <b>{(b - a).toFixed(1)} h</b>
                        </div>
                        {l.merged && si === segs.length - 1 && (
                          <>
                            <div className="hr" />
                            <div className="r">
                              Merged<b>{l.pr ?? 'a pull request'}</b>
                            </div>
                          </>
                        )}
                      </>,
                      ev,
                    )
                  }
                  onMouseLeave={tip.hide}
                />
              ))}
              {l.merged && (
                <g
                  onMouseMove={(ev) =>
                    tip.show(
                      <>
                        <div className="t">Merged {l.pr ?? 'a pull request'}</div>
                        <div className="r muted">
                          {laneName(l)} · {hm(end)}
                        </div>
                      </>,
                      ev,
                    )
                  }
                  onMouseLeave={tip.hide}
                >
                  <circle
                    cx={x(end)}
                    cy={cy}
                    r={7}
                    style={{ fill: 'var(--violet)', stroke: 'var(--card)' }}
                    strokeWidth={2}
                  />
                  <path
                    d={`M${x(end) - 3},${cy}l2,2l4,-4`}
                    fill="none"
                    stroke="#fff"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Boxes at once, every day: peak bars and the average line

export interface ConcRow {
  date: string;
  peak: number;
  avgAtOnce: number;
  agentHours: number;
  prsMerged: number;
}

export function ConcChart({ rows }: { rows: readonly ConcRow[] }): ReactElement {
  const [ref, W] = useWidth<HTMLDivElement>(560);
  const tip = useTip();
  const H = 230;
  const L = 30;
  const R = 8;
  const T = 12;
  const B = 26;
  const top = max0(rows.map((r) => r.peak));
  const max = top <= 10 ? Math.max(4, Math.ceil((top + 1) / 2) * 2) : niceMax(top);
  const ticks =
    max <= 12
      ? Array.from({ length: max / 2 + 1 }, (_, i) => i * 2)
      : [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const y = (v: number): number => T + (H - T - B) * (1 - v / max);
  const n = Math.max(rows.length, 1);
  const slot = Math.max(0, (W - L - R) / n);
  const bw = Math.max(1, Math.min(16, slot - 3));
  const px = (i: number): number => L + slot * i + slot / 2;
  const line = rows.map((r, i) => `${px(i)},${y(r.avgAtOnce)}`).join(' L');
  const last = rows[rows.length - 1];
  return (
    <div ref={ref} className="chart-wrap">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Boxes at once per day"
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v ? 'grid-line' : 'axis-line'} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const bx = L + slot * i + (slot - bw) / 2;
          const best = r.peak === top && top > 0;
          return (
            <g key={r.date}>
              {r.peak > 0 && (
                <path
                  d={barPath(bx, y(r.peak), bw, y(0) - y(r.peak), 4)}
                  className="u-grow"
                  style={{ fill: best ? 'var(--w4)' : 'var(--w2)', animationDelay: `${i * 18}ms` }}
                />
              )}
              {best && (
                <text x={bx + bw / 2} y={y(r.peak) - 6} textAnchor="middle" className="peak-label">
                  {r.peak}
                </text>
              )}
              {dayTick(r.date, i, rows.length) && (
                <text x={bx + bw / 2} y={H - 6} textAnchor="middle">
                  {dayTick(r.date, i, rows.length)}
                </text>
              )}
            </g>
          );
        })}
        {rows.length > 1 && (
          <path
            d={`M${line}`}
            fill="none"
            style={{ stroke: 'var(--s6)' }}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {last && (
          <circle
            cx={px(rows.length - 1)}
            cy={y(last.avgAtOnce)}
            r={4}
            style={{ fill: 'var(--s6)', stroke: 'var(--card)' }}
            strokeWidth={2}
          />
        )}
        {rows.map((r, i) => (
          <rect
            key={r.date}
            x={L + slot * i}
            y={T}
            width={slot}
            height={H - T - B}
            fill="transparent"
            onMouseMove={(ev) =>
              tip.show(
                <>
                  <div className="t">{dayMonth(r.date)}</div>
                  <TipRow color="var(--w3)" label="Most at once" value={r.peak} />
                  <TipRow color="var(--s6)" label="Average" value={r.avgAtOnce.toFixed(1)} />
                  <div className="hr" />
                  <div className="r muted">
                    {nf(r.agentHours)} agent-hours · {r.prsMerged} PRs
                  </div>
                </>,
                ev,
              )
            }
            onMouseLeave={tip.hide}
          />
        ))}
      </svg>
    </div>
  );
}

/** Which x labels to print: day 1 and every 5th in a month, sparser for longer windows. */
export function dayTick(date: string, i: number, n: number): string | null {
  const d = dayNum(date);
  if (n <= 8) return `${DOW[dow(date)]} ${d}`;
  if (n <= 31) return d === 1 || d % 5 === 0 ? String(d) : i === 0 ? String(d) : null;
  if (n <= 120) return d === 1 || d === 15 ? `${d} ${MONTHS[monthIdx(date)]}` : null;
  return d === 1 ? MONTHS[monthIdx(date)]! : null;
}

// ---------------------------------------------------------------------------
// Daily stacked bars, with a hatched forecast to the end of the window

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

export interface StackRow {
  date: string;
  forecast: boolean;
  total: number;
  /** Values per series key, summing to `total` (or less). */
  parts: Record<string, number>;
  prsMerged: number;
  commits: number;
}

export function DailyChart({
  rows,
  series,
  format,
  showToday,
}: {
  rows: readonly StackRow[];
  series: readonly StackSeries[];
  format: (v: number) => string;
  showToday: boolean;
}): ReactElement {
  const [ref, W] = useWidth<HTMLDivElement>(1100);
  const tip = useTip();
  const hatchId = useId().replace(/:/g, '');
  const H = 300;
  const L = 48;
  const R = 8;
  const T = 12;
  const B = 40;
  const max = niceMax(max0(rows.map((r) => r.total)));
  const y = (v: number): number => T + (H - T - B) * (1 - v / max);
  const n = Math.max(rows.length, 1);
  const slot = Math.max(0, (W - L - R) / n);
  const bw = Math.max(1, Math.min(24, slot - 4));
  const todayIdx = rows.findIndex((r) => r.forecast);
  return (
    <div ref={ref} className="chart-wrap">
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Per day">
        <defs>
          <pattern
            id={hatchId}
            width={5}
            height={5}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width={5} height={5} style={{ fill: 'var(--hatch-bg)' }} />
            <rect width={2} height={5} style={{ fill: 'var(--s1)' }} fillOpacity={0.55} />
          </pattern>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => {
          const v = (max / 4) * i;
          return (
            <g key={i}>
              <line
                x1={L}
                x2={W - R}
                y1={y(v)}
                y2={y(v)}
                className={i ? 'grid-line' : 'axis-line'}
              />
              <text x={L - 8} y={y(v) + 4} textAnchor="end">
                {i ? format(v) : '0'}
              </text>
            </g>
          );
        })}
        {showToday && todayIdx > 0 && (
          <>
            <line
              x1={L + slot * todayIdx}
              x2={L + slot * todayIdx}
              y1={T}
              y2={H - B + 6}
              style={{ stroke: 'var(--faint)' }}
              strokeDasharray="3 3"
            />
            <text
              x={L + slot * todayIdx - slot / 2}
              y={H - 6}
              textAnchor="middle"
              className="today-label"
            >
              today
            </text>
          </>
        )}
        {rows.map((r, i) => {
          const x = L + slot * i + (slot - bw) / 2;
          const label = dayTick(r.date, i, rows.length);
          let acc = 0;
          const present = series.filter((s) => (r.parts[s.key] ?? 0) > 0);
          return (
            <g key={r.date}>
              <g className="u-grow" style={{ animationDelay: `${i * 18}ms` }}>
                {r.forecast
                  ? r.total > 0 && (
                      <path
                        d={barPath(x, y(r.total), bw, y(0) - y(r.total), 4)}
                        fill={`url(#${hatchId})`}
                      />
                    )
                  : present.map((s, si) => {
                      const seg = r.parts[s.key] ?? 0;
                      const y1 = y(acc + seg);
                      const y0 = y(acc);
                      acc += seg;
                      const isTop = si === present.length - 1;
                      const h = Math.max(0, y0 - y1 - (si ? 2 : 0));
                      if (h <= 0.4) return null;
                      return (
                        <path
                          key={s.key}
                          d={isTop ? barPath(x, y1, bw, h, 4) : `M${x},${y1}h${bw}v${h}h${-bw}z`}
                          style={{ fill: s.color }}
                        />
                      );
                    })}
              </g>
              {label && (
                <text x={x + bw / 2} y={H - B + 18} textAnchor="middle">
                  {label}
                </text>
              )}
              <rect
                x={L + slot * i}
                y={T}
                width={slot}
                height={H - T - B}
                fill="transparent"
                onMouseMove={(ev) =>
                  tip.show(
                    <>
                      <div className="t">
                        {dayMonth(r.date)}
                        {r.forecast && <span className="muted"> forecast</span>}
                      </div>
                      {!r.forecast && (
                        <>
                          {[...present]
                            .sort((a, b) => (r.parts[b.key] ?? 0) - (r.parts[a.key] ?? 0))
                            .map((s) => (
                              <TipRow
                                key={s.key}
                                color={s.color}
                                label={s.label}
                                value={format(r.parts[s.key] ?? 0)}
                              />
                            ))}
                          <div className="hr" />
                        </>
                      )}
                      <div className="r">
                        Total<b>{format(r.total)}</b>
                      </div>
                      {!r.forecast && (
                        <div className="r muted">
                          {r.prsMerged} PRs merged · {nf(r.commits)} commits
                        </div>
                      )}
                    </>,
                    ev,
                  )
                }
                onMouseLeave={tip.hide}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity wall: one square per day, weeks as columns, Sunday on top

export interface WallCell {
  date: string;
  value: number;
  /** The tooltip body; null for an empty day. */
  detail: ReactNode;
}

const WALL_RAMP = ['var(--w0)', 'var(--w1)', 'var(--w2)', 'var(--w3)', 'var(--w4)', 'var(--w5)'];

/** Quantile cuts over the non-zero values, so one huge day does not flatten the rest. */
export function wallLevels(values: readonly number[]): (v: number) => number {
  const vals = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number): number => vals[Math.floor(p * (vals.length - 1))] ?? 1;
  const cuts = [q(0.2), q(0.45), q(0.7), q(0.9)];
  return (v: number) => (v <= 0 ? 0 : 1 + cuts.filter((c) => v > c).length);
}

export function Wall({
  cells,
  firstDate,
}: {
  cells: readonly WallCell[];
  firstDate: string | null;
}): ReactElement {
  const [ref, avail] = useWidth<HTMLDivElement>(900);
  const tip = useTip();
  const gap = 3;
  const L = 30;
  const T = 18;
  const lead = cells.length ? dow(cells[0]!.date) : 0;
  const weeks = Math.max(1, Math.ceil((cells.length + lead) / 7));
  const cell = Math.max(9, Math.min(16, Math.floor((avail - L) / weeks) - gap));
  const W = L + weeks * (cell + gap);
  const H = T + 7 * (cell + gap);
  const level = useMemo(() => wallLevels(cells.map((c) => c.value)), [cells]);
  // On a narrow screen the wall scrolls sideways: start at today, not a year ago.
  useEffect(() => {
    const scroller = ref.current?.parentElement;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, [ref, W]);
  let lastMonth = -1;
  return (
    <div ref={ref} className="wall-measure">
      <svg
        className="wall-svg"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Activity per day"
      >
        {['Mon', 'Wed', 'Fri'].map((name, i) => (
          <text key={name} x={0} y={T + (i * 2 + 1) * (cell + gap) + cell / 2 + 4}>
            {name}
          </text>
        ))}
        {cells.map((c, idx) => {
          const i = idx + lead;
          const w = Math.floor(i / 7);
          const dw = i % 7;
          const x = L + w * (cell + gap);
          const yy = T + dw * (cell + gap);
          let month: string | null = null;
          if ((dw === 0 || idx === 0) && monthIdx(c.date) !== lastMonth && dayNum(c.date) <= 7) {
            lastMonth = monthIdx(c.date);
            month = MONTHS[lastMonth]!;
          }
          const isToday = idx === cells.length - 1;
          return (
            <g key={c.date}>
              {month && (
                <text x={x} y={11}>
                  {month}
                </text>
              )}
              <rect
                x={x}
                y={yy}
                width={cell}
                height={cell}
                rx={3}
                className="cell u-pop"
                style={{ fill: WALL_RAMP[level(c.value)], animationDelay: `${w * 14 + dw * 6}ms` }}
                onMouseMove={(ev) =>
                  tip.show(
                    <>
                      <div className="t">{fullDay(c.date)}</div>
                      {c.detail ?? (
                        <div className="muted">
                          {firstDate && c.date < firstDate
                            ? 'Before your first box'
                            : 'No activity'}
                        </div>
                      )}
                    </>,
                    ev,
                  )
                }
                onMouseLeave={tip.hide}
              />
              {isToday && (
                <rect
                  x={x - 1.5}
                  y={yy - 1.5}
                  width={cell + 3}
                  height={cell + 3}
                  rx={4}
                  fill="none"
                  style={{ stroke: 'var(--ink)' }}
                  strokeWidth={1.5}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function HeroPixels({ values }: { values: readonly number[] }): ReactElement {
  const cell = 9;
  const gap = 3;
  const weeks = 30;
  const recent = values.slice(-weeks * 7);
  const max = max0(recent) || 1;
  const tones = [
    'var(--px0)',
    'var(--px1)',
    'var(--px2)',
    'var(--px3)',
    'var(--px4)',
    'var(--px5)',
  ];
  return (
    <svg className="hero-pixels" width={weeks * (cell + gap)} height={7 * (cell + gap)} aria-hidden>
      {recent.map((v, i) => {
        const w = Math.floor(i / 7);
        const lv = v ? Math.min(5, 1 + Math.floor((v / max) * 5)) : 0;
        return (
          <rect
            key={i}
            x={w * (cell + gap)}
            y={(i % 7) * (cell + gap)}
            width={cell}
            height={cell}
            rx={2}
            style={{ fill: tones[lv] }}
            opacity={0.25 + (w / weeks) * 0.75}
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Punchcard: when the agents work

export function Punchcard({ grid }: { grid: readonly (readonly number[])[] }): ReactElement {
  const [ref, W] = useWidth<HTMLDivElement>(560);
  const tip = useTip();
  const H = 230;
  const L = 36;
  const T = 8;
  const B = 26;
  const R = 6;
  const cw = Math.max(0, (W - L - R) / 24);
  const ch = (H - T - B) / 7;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const max = max0(grid.flat()) || 1;
  return (
    <div ref={ref} className="chart-wrap">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Agent-hours by hour of day"
      >
        <rect
          x={L}
          y={T - 4}
          width={cw * 7}
          height={H - T - B + 8}
          rx={6}
          style={{ fill: 'var(--night)' }}
        />
        <text x={L + cw * 3.5} y={H - 2} textAnchor="middle" className="night-label">
          overnight
        </text>
        {order.map((d, ri) => (
          <g key={d}>
            <text x={0} y={T + ri * ch + ch / 2 + 4}>
              {DOW[d]}
            </text>
            {(grid[d] ?? []).map((v, h) => {
              const rr = Math.max(1.5, Math.sqrt(v / max) * Math.min(cw, ch) * 0.46);
              return (
                <circle
                  key={h}
                  cx={L + h * cw + cw / 2}
                  cy={T + ri * ch + ch / 2}
                  r={rr}
                  className="u-pop"
                  style={{
                    fill: h < 7 ? 'var(--s6)' : 'var(--w4)',
                    animationDelay: `${(ri * 24 + h) * 4}ms`,
                  }}
                  fillOpacity={0.25 + 0.75 * (v / max)}
                  onMouseMove={(ev) =>
                    tip.show(
                      <>
                        <div className="t">
                          {DOW[d]}s, {String(h).padStart(2, '0')}:00–
                          {String(h + 1).padStart(2, '0')}:00
                        </div>
                        <div className="r">
                          Agent-hours<b>{Math.round(v * 10) / 10} h</b>
                        </div>
                      </>,
                      ev,
                    )
                  }
                  onMouseLeave={tip.hide}
                />
              );
            })}
          </g>
        ))}
        {[0, 6, 12, 18, 23].map((h) => (
          <text key={h} x={L + h * cw + cw / 2} y={H - 14} textAnchor="middle">
            {String(h).padStart(2, '0')}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lines changed per day: additions up, deletions down

export interface DiffRow {
  date: string;
  additions: number;
  deletions: number;
  prsMerged: number;
}

export function DiffChart({ rows }: { rows: readonly DiffRow[] }): ReactElement {
  const [ref, W] = useWidth<HTMLDivElement>(560);
  const tip = useTip();
  const H = 240;
  const L = 46;
  const R = 8;
  const T = 10;
  const B = 26;
  const maxA = niceMax(max0(rows.map((r) => r.additions)));
  const maxD = niceMax(max0(rows.map((r) => r.deletions)));
  const span = maxA + maxD;
  const mid = T + (H - T - B) * (maxA / span);
  const k = (H - T - B) / span;
  const n = Math.max(rows.length, 1);
  const slot = Math.max(0, (W - L - R) / n);
  const bw = Math.max(1, Math.min(16, slot - 3));
  return (
    <div ref={ref} className="chart-wrap">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Lines changed per day"
      >
        {[maxA, maxA / 2, 0, -maxD].map((v) => (
          <g key={v}>
            <line
              x1={L}
              x2={W - R}
              y1={mid - v * k}
              y2={mid - v * k}
              className={v === 0 ? 'axis-line' : 'grid-line'}
            />
            <text x={L - 8} y={mid - v * k + 4} textAnchor="end">
              {v === 0 ? '0' : (v > 0 ? '+' : '−') + fmt(Math.abs(v))}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = L + slot * i + (slot - bw) / 2;
          const label = dayTick(r.date, i, rows.length);
          const net = r.additions - r.deletions;
          return (
            <g key={r.date}>
              {r.additions > 0 && (
                <path
                  d={barPath(x, mid - r.additions * k, bw, Math.max(0, r.additions * k - 1), 4)}
                  className="u-grow"
                  style={{ fill: 'var(--add)', animationDelay: `${i * 20}ms` }}
                />
              )}
              {r.deletions > 0 && (
                <path
                  d={barPathDown(x, mid + 1, bw, Math.max(0, r.deletions * k - 1), 4)}
                  style={{ fill: 'var(--del)' }}
                  fillOpacity={0.85}
                />
              )}
              {label && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle">
                  {label}
                </text>
              )}
              <rect
                x={L + slot * i}
                y={T}
                width={slot}
                height={H - T - B}
                fill="transparent"
                onMouseMove={(ev) =>
                  tip.show(
                    <>
                      <div className="t">{dayMonth(r.date)}</div>
                      <TipRow color="var(--add)" label="Added" value={'+' + nf(r.additions)} />
                      <TipRow color="var(--del)" label="Removed" value={'−' + nf(r.deletions)} />
                      <div className="hr" />
                      <div className="r">
                        {r.prsMerged} PRs merged
                        <b>
                          net {net >= 0 ? '+' : '−'}
                          {nf(Math.abs(net))}
                        </b>
                      </div>
                    </>,
                    ev,
                  )
                }
                onMouseLeave={tip.hide}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
