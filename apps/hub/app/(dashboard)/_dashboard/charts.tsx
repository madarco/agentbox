'use client';

// Hand-drawn SVG charts for the Dashboard (no chart library): a sparkline, KPI
// mini bars, the week's bars and the day's lanes. Colors are theme tokens.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { agentIcon } from '@/components/icons';
import type { Lane } from '@/lib/dashboard-view';
import { cn } from '@/lib/utils';

/** The element's width, so a chart draws at real pixels (crisp lines, round dots). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const smooth = (pts: Array<[number, number]>): string => {
  if (pts.length < 2) return '';
  let d = `M${String(pts[0]![0])},${String(pts[0]![1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const mx = (x0 + x1) / 2;
    d += ` C${String(mx)},${String(y0)} ${String(mx)},${String(y1)} ${String(x1)},${String(y1)}`;
  }
  return d;
};

export function Sparkline({
  data,
  color = 'var(--c1)',
  height = 36,
  className,
  step,
  dot = true,
  label,
}: {
  data: number[];
  color?: string;
  height?: number;
  className?: string;
  /** Step line (counts) instead of a curve. */
  step?: boolean;
  dot?: boolean;
  label?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const id = useId().replace(/:/g, '');
  const max = Math.max(1, ...data);
  const pad = 3;
  const pts: Array<[number, number]> =
    w && data.length > 1
      ? data.map((v, i) => [
          pad + (i * (w - pad * 2)) / (data.length - 1),
          height - pad - (v / max) * (height - pad * 2),
        ])
      : [];
  const line = step
    ? pts
        .map((p, i) =>
          i ? `H${String(p[0])}V${String(p[1])}` : `M${String(p[0])},${String(p[1])}`,
        )
        .join('')
    : smooth(pts);
  const last = pts[pts.length - 1];
  return (
    <div
      ref={ref}
      className={cn('w-full', className)}
      style={{ height }}
      role="img"
      aria-label={label}
    >
      {w && last ? (
        <svg width={w} height={height} className="block overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity=".22" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`${line} L${String(last[0])},${String(height)} L${String(pts[0]![0])},${String(height)} Z`}
            fill={`url(#${id})`}
          />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {dot ? (
            <circle
              cx={last[0]}
              cy={last[1]}
              r="2.6"
              fill={color}
              stroke="hsl(var(--card))"
              strokeWidth="1.5"
            />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

export function MiniBars({
  data,
  color = 'var(--c1)',
  height = 34,
  className,
  label,
}: {
  data: number[];
  color?: string;
  height?: number;
  className?: string;
  label?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const max = Math.max(1, ...data);
  const gap = 3;
  const bw = w ? (w - gap * (data.length - 1)) / data.length : 0;
  return (
    <div
      ref={ref}
      className={cn('w-full', className)}
      style={{ height }}
      role="img"
      aria-label={label}
    >
      {w ? (
        <svg width={w} height={height} className="block" aria-hidden="true">
          {data.map((v, i) => {
            const h = Math.max(2, (v / max) * (height - 2));
            return (
              <rect
                key={i}
                x={i * (bw + gap)}
                y={height - h}
                width={bw}
                height={h}
                rx="2"
                fill={color}
                opacity={i === data.length - 1 ? 1 : 0.32}
              />
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}

/** Bars per day with an axis, hover tooltips and a dot per merged PR above each bar. */
export function WeekBars({
  labels,
  values,
  secondary,
  color = 'var(--c1)',
  height = 160,
  tip,
}: {
  labels: string[];
  values: number[];
  secondary?: number[];
  color?: string;
  height?: number;
  tip: (i: number) => ReactNode;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const top = 14;
  const bottom = 22;
  // Room above the tallest bar for its PR dots.
  const dots = Math.max(0, ...(secondary ?? [0]));
  const max = Math.max(1, ...values) * 1.12;
  const gap = 10;
  const bw = w ? (w - gap * (values.length - 1)) / values.length : 0;
  const plotTop = top + Math.min(dots, 6) * 8;
  const y = (v: number) => plotTop + (1 - v / max) * (height - plotTop - bottom);
  return (
    <div
      ref={ref}
      className="relative w-full"
      style={{ height }}
      onMouseLeave={() => setHover(null)}
    >
      {w ? (
        <svg width={w} height={height} className="block" role="img" aria-label="Commits per day">
          {[0.5, 1].map((f) => (
            <line
              key={f}
              x1="0"
              x2={w}
              y1={y((max * f) / 1.12)}
              y2={y((max * f) / 1.12)}
              stroke="var(--grid)"
              strokeDasharray="2 4"
            />
          ))}
          <line
            x1="0"
            x2={w}
            y1={height - bottom}
            y2={height - bottom}
            stroke="hsl(var(--border))"
          />
          {values.map((v, i) => {
            const x = i * (bw + gap);
            const last = i === values.length - 1;
            const n = Math.min(secondary?.[i] ?? 0, 6);
            return (
              <g key={i} onMouseEnter={() => setHover(i)}>
                <rect x={x} y={top} width={bw} height={height - top - bottom} fill="transparent" />
                <rect
                  x={x}
                  y={y(v)}
                  width={bw}
                  height={Math.max(2, height - bottom - y(v))}
                  rx="4"
                  fill={color}
                  opacity={hover === i || (hover === null && last) ? 1 : 0.38}
                />
                {Array.from({ length: n }).map((_, k) => (
                  <circle
                    key={k}
                    cx={x + bw / 2}
                    cy={y(v) - 7 - k * 8}
                    r="2.6"
                    fill="var(--violet)"
                  />
                ))}
                <text
                  x={x + bw / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground font-mono"
                  fontSize="10.5"
                >
                  {labels[i]}
                </text>
              </g>
            );
          })}
        </svg>
      ) : null}
      {hover !== null && w ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{
            left: Math.min(Math.max(hover * (bw + gap) + bw / 2, 70), w - 70),
            top: y(values[hover] ?? 0) - 10 - Math.min(secondary?.[hover] ?? 0, 6) * 8,
          }}
        >
          {tip(hover)}
        </div>
      ) : null}
    </div>
  );
}

const SEG_COLOR = { running: 'var(--c1)', paused: 'var(--faint)' } as const;

/** What each box did over the window, now on the right. */
export function Lanes({
  lanes,
  span = 12,
  rowH = 30,
  onOpen,
}: {
  lanes: Lane[];
  span?: number;
  rowH?: number;
  onOpen?: (boxId: string) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const labelW = w < 520 ? 130 : 210;
  const plotW = Math.max(0, w - labelW - 16);
  const x = (hAgo: number) => labelW + (1 - Math.min(span, hAgo) / span) * plotW;
  const H = lanes.length * rowH + 26;
  const ticks = [12, 9, 6, 3, 0].filter((t) => t <= span);
  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
      {w ? (
        <svg
          width={w}
          height={H}
          className="block"
          role="group"
          aria-label={`Boxes over the last ${String(span)} hours`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1="0"
                y2={H - 22}
                stroke="var(--grid)"
                strokeDasharray={t === 0 ? '' : '2 4'}
              />
              <text
                x={x(t)}
                y={H - 6}
                textAnchor={t === 0 ? 'end' : 'middle'}
                className="fill-muted-foreground font-mono"
                fontSize="10.5"
              >
                {t === 0 ? 'now' : `-${String(t)}h`}
              </text>
            </g>
          ))}
          {lanes.map((l, i) => {
            const cy = i * rowH + rowH / 2;
            const live = l.box?.status === 'running';
            const Glyph = agentIcon(l.agent ?? '');
            const boxId = l.box?.id;
            return (
              <g
                key={l.key}
                className={boxId ? 'cursor-pointer outline-none' : ''}
                onClick={() => boxId && onOpen?.(boxId)}
                onMouseEnter={() => setHover(i)}
                // A lane with a box is a link to it, by keyboard too.
                {...(boxId
                  ? {
                      role: 'link',
                      tabIndex: 0,
                      'aria-label': `Open ${l.label}`,
                      onFocus: () => setHover(i),
                      onBlur: () => setHover(null),
                      onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onOpen?.(boxId);
                        }
                      },
                    }
                  : {})}
              >
                <rect
                  x="0"
                  y={i * rowH}
                  width={w}
                  height={rowH}
                  fill={hover === i ? 'hsl(var(--muted) / .55)' : 'transparent'}
                  rx="6"
                />
                <foreignObject x="6" y={i * rowH + 3} width={labelW - 14} height={rowH - 6}>
                  <div className="flex h-full items-center gap-2 text-[12.5px] leading-tight text-foreground">
                    <Glyph className="size-3.5 flex-none text-muted-foreground" />
                    <span className="min-w-0 truncate">{l.label}</span>
                  </div>
                </foreignObject>
                <line x1={labelW} x2={labelW + plotW} y1={cy} y2={cy} stroke="var(--grid)" />
                {l.segs.map(([f, e, k], j) => {
                  const run = k === 'running';
                  return (
                    <rect
                      key={j}
                      x={x(f)}
                      y={cy - (run ? 5 : 3)}
                      width={Math.max(2, x(e) - x(f))}
                      height={run ? 10 : 6}
                      rx={run ? 5 : 3}
                      fill={SEG_COLOR[k]}
                      opacity={run ? 0.9 : 0.55}
                    />
                  );
                })}
                {live ? (
                  <circle
                    cx={x(0)}
                    cy={cy}
                    r="4"
                    fill="var(--c1)"
                    stroke="hsl(var(--card))"
                    strokeWidth="2"
                  />
                ) : null}
                {l.pushes.map((c, j) => (
                  <circle
                    key={`c${String(j)}`}
                    cx={x(c)}
                    cy={cy}
                    r="2.4"
                    fill="hsl(var(--card))"
                    stroke="var(--green-ink)"
                    strokeWidth="1.4"
                  />
                ))}
                {l.merges.map((p, j) => (
                  <g key={`p${String(j)}`} transform={`translate(${String(x(p))},${String(cy)})`}>
                    <rect
                      x="-5"
                      y="-5"
                      width="10"
                      height="10"
                      rx="2"
                      transform="rotate(45)"
                      fill="var(--violet)"
                      stroke="hsl(var(--card))"
                      strokeWidth="1.5"
                    />
                  </g>
                ))}
                <title>{l.label}</title>
              </g>
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}

export function Legend({
  items,
}: {
  items: Array<{ label: string; color?: string; shape?: 'bar' | 'dot' | 'diamond'; op?: number }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-muted-foreground">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          {it.shape === 'dot' ? (
            <span className="size-[7px] rounded-full border-[1.4px] border-[var(--green-ink)] bg-card" />
          ) : it.shape === 'diamond' ? (
            <span
              className="size-[7px] rotate-45 rounded-[1.5px]"
              style={{ background: it.color }}
            />
          ) : (
            <span
              className="h-[6px] w-3 rounded-full"
              style={{ background: it.color, opacity: it.op ?? 0.9 }}
            />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}
