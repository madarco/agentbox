import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import { hoursSaved } from '@agentbox/usage-view';
import type { AgentId, ProviderId, UsageShare } from '@agentbox/usage-view';
import { OG, boxMark, loadOgFonts } from '@/lib/og';
import { TAGLINE, dayMonth, hasSaving, hasSpeedup, num, shareTitle, speedup } from './format';
import { dailySeries } from './og-series';
import type { DailySeries } from './og-series';

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT =
  'Usage shared from AgentBox: coding agents running at the same time, hours of agent work, hours saved against one agent at a time, and charts of agents at once and agent-hours over the period';

const mono = 'IBM Plex Mono';
const sans = 'IBM Plex Sans';

// Series colours per agent (packages/usage-view usage.css --s1..--s5, --faint).
const AGENT_COLOR: Record<AgentId, string> = {
  claude: '#2a78d6',
  codex: '#eb6834',
  pi: '#1baf7a',
  opencode: '#eda100',
  openclaw: '#e87ba4',
  other: '#a4a9b0',
};
const INK_2 = '#3d434c';
const BAR_EMPTY = '#ebebe6';

// Round provider marks in brand colour, as drawn by usage-view's ProviderLogo. Copied
// rather than imported: that module is client code, and satori needs plain SVG.
const PROVIDER: Record<ProviderId, { label: string; bg: string; mark: ReactElement }> = {
  docker: {
    label: 'Docker',
    bg: '#1d63ed',
    mark: (
      <g fill="#fff">
        <rect x="5" y="10" width="3" height="3" rx=".5" />
        <rect x="8.6" y="10" width="3" height="3" rx=".5" />
        <rect x="12.2" y="10" width="3" height="3" rx=".5" />
        <rect x="8.6" y="6.4" width="3" height="3" rx=".5" />
        <rect x="12.2" y="6.4" width="3" height="3" rx=".5" />
        <path d="M4 14h13.5c.8-1.6 2.2-2.2 3-2-.2 1-.9 1.6-1.6 1.9C17.8 17 15 19 10.5 19 6.5 19 4.6 17 4 14z" />
      </g>
    ),
  },
  hetzner: {
    label: 'Hetzner',
    bg: '#d50c2d',
    mark: <path fill="#fff" d="M7 6h3v4.6h4V6h3v12h-3v-4.6h-4V18H7z" />,
  },
  daytona: {
    label: 'Daytona',
    bg: '#16181c',
    mark: <path fill="none" stroke="#fff" strokeWidth="2.4" d="M8 6.5h3.5a5.5 5.5 0 010 11H8z" />,
  },
  vercel: { label: 'Vercel', bg: '#000000', mark: <path fill="#fff" d="M12 6.5l6.5 11h-13z" /> },
  // usage-view draws "e2b" as SVG text, which satori does not render: three bars instead.
  e2b: {
    label: 'E2B',
    bg: '#ff8800',
    mark: (
      <g fill="#fff">
        <rect x="6.5" y="7" width="11" height="2.2" rx="1.1" />
        <rect x="6.5" y="10.9" width="11" height="2.2" rx="1.1" />
        <rect x="6.5" y="14.8" width="11" height="2.2" rx="1.1" />
      </g>
    ),
  },
  'remote-docker': {
    label: 'Remote Docker',
    bg: '#3d434c',
    mark: (
      <g>
        <g fill="none" stroke="#fff" strokeWidth="1.8">
          <rect x="5.5" y="6" width="13" height="5" rx="1.2" />
          <rect x="5.5" y="13" width="13" height="5" rx="1.2" />
        </g>
        <circle cx="8.5" cy="8.5" r="1" fill="#fff" />
        <circle cx="8.5" cy="15.5" r="1" fill="#fff" />
      </g>
    ),
  },
  digitalocean: {
    label: 'DigitalOcean',
    bg: '#0069ff',
    mark: (
      <path
        fill="#fff"
        d="M12 18.5v-2.7a3.8 3.8 0 10-3.8-3.8H5.5A6.5 6.5 0 1112 18.5zM9.3 16.3H12V19H9.3zM7.2 18.4h2.1v2.1H7.2zM7.2 14.2H9.3v2.1H7.2z"
      />
    ),
  },
  host: {
    label: 'this PC',
    bg: '#5b616b',
    mark: (
      <g fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
        <rect x="5" y="6.5" width="14" height="9" rx="1.5" />
        <path d="M9 18.5h6" />
      </g>
    ),
  },
  other: {
    label: 'other',
    bg: '#a4a9b0',
    mark: (
      <g fill="#fff">
        <circle cx="8" cy="12" r="1.4" />
        <circle cx="12" cy="12" r="1.4" />
        <circle cx="16" cy="12" r="1.4" />
      </g>
    ),
  },
};

function ProviderAvatar({ id, size, overlap }: { id: ProviderId; size: number; overlap: boolean }) {
  const p = PROVIDER[id];
  return (
    <div
      style={{
        display: 'flex',
        width: size + 6,
        height: size + 6,
        borderRadius: size,
        backgroundColor: OG.paper,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: overlap ? -14 : 0,
      }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="12" fill={p.bg} />
        {p.mark}
      </svg>
    </div>
  );
}

/** Font size that keeps `text` on one line within `width` (Plex at ~0.55em per glyph). */
const fit = (text: string, max: number, width: number): number =>
  Math.min(max, Math.floor(width / (text.length * 0.55)));

/** 9,999,999 stays readable up to 6 digits, then 1.2M. */
const compact = (v: number): string =>
  v < 1_000_000 ? num(v) : `${(Math.floor(v / 100_000) / 10).toFixed(1)}M`;

const W = 1072;
const CHART_W = 516;
const CHART_H = 150;

/** A big number over a small label that says what it counts. */
function Headline({
  value,
  label,
  color,
  width,
}: {
  value: string;
  label: string;
  color: string;
  width: number;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width }}>
      <div
        style={{
          display: 'flex',
          fontSize: fit(value, 76, width - 10),
          fontWeight: 600,
          color,
          letterSpacing: '-0.03em',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      <div style={{ display: 'flex', fontSize: 21, color: INK_2, marginTop: 8, lineHeight: 1.25 }}>
        {label}
      </div>
    </div>
  );
}

function ChartTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
      <div style={{ display: 'flex', fontSize: 22, fontWeight: 600, color: OG.ink }}>{title}</div>
      {note && (
        <div
          style={{
            display: 'flex',
            marginLeft: 'auto',
            fontFamily: mono,
            fontSize: 17,
            color: OG.muted,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}

/** Bar geometry shared by both charts: slot width and a gap that shrinks with it. */
function slots(n: number): { step: number; bar: number } {
  const step = CHART_W / n;
  return { step, bar: Math.max(1, step - Math.min(4, step * 0.25)) };
}

/** A sliver for a day with no activity, so the timeline still reads as days. */
const EMPTY_H = 3;

// A plain function, not a component: satori serializes <svg> children as they are and
// does not render components inside it.
const emptySlot = (key: number, x: number, width: number): ReactElement => (
  <rect key={key} x={x} y={CHART_H - EMPTY_H} width={width} height={EMPTY_H} fill={BAR_EMPTY} />
);

function PeakChart({ s }: { s: DailySeries }) {
  const { step, bar } = slots(s.bars.length);
  const max = Math.max(1, s.maxPeak);
  return (
    <svg width={CHART_W} height={CHART_H} viewBox={`0 0 ${CHART_W} ${CHART_H}`}>
      {s.bars.map((b, i) => {
        if (!b || b.peak === 0) return emptySlot(i, i * step, bar);
        const h = Math.max(4, (b.peak / max) * CHART_H);
        return (
          <rect
            key={i}
            x={i * step}
            y={CHART_H - h}
            width={bar}
            height={h}
            rx={Math.min(3, bar / 3)}
            fill={i === s.peakIndex ? OG.accent : '#86cfa2'}
          />
        );
      })}
    </svg>
  );
}

function HoursChart({ s }: { s: DailySeries }) {
  const { step, bar } = slots(s.bars.length);
  const max = s.maxHours > 0 ? s.maxHours : 1;
  return (
    <svg width={CHART_W} height={CHART_H} viewBox={`0 0 ${CHART_W} ${CHART_H}`}>
      {s.bars.map((b, i) => {
        const total = b ? b.hours.reduce((a, v) => a + v, 0) : 0;
        if (!b || total <= 0) return emptySlot(i, i * step, bar);
        let y = CHART_H;
        return (
          <g key={i}>
            {b.hours.map((v, k) => {
              if (v <= 0) return null;
              const h = (v / max) * CHART_H;
              y -= h;
              return (
                <rect
                  key={k}
                  x={i * step}
                  y={y}
                  width={bar}
                  height={h}
                  fill={AGENT_COLOR[s.agents[k]!]}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function Legend({ agents }: { agents: AgentId[] }) {
  return (
    <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
      {agents.map((a) => (
        <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            style={{
              display: 'flex',
              width: 13,
              height: 13,
              borderRadius: 3,
              backgroundColor: AGENT_COLOR[a],
            }}
          />
          <div style={{ display: 'flex', fontFamily: mono, fontSize: 17, color: OG.muted }}>
            {a}
          </div>
        </div>
      ))}
    </div>
  );
}

function OgCard({ share }: { share: UsageShare }) {
  const h = share.hero;
  const s = dailySeries(share);
  const per =
    s.bucketDays === 1 ? 'per day' : s.bucketDays === 7 ? 'per week' : `per ${s.bucketDays} days`;
  const title = shareTitle(share);
  const providers = [...share.providers].sort((a, b) => b.hours - a.hours).slice(0, 3);
  const names = providers.map((p) => PROVIDER[p.id].label);
  const one = (n: number, a: string, b: string): string => (num(n) === '1' ? a : b);

  const saved = hoursSaved(h);
  const third = hasSaving(share)
    ? {
        value: compact(saved),
        label: `${one(saved, 'hour', 'hours')} saved, ${speedup(h.speedup)} faster than one agent`,
      }
    : hasSpeedup(share)
      ? { value: speedup(h.speedup), label: 'faster than one agent' }
      : // The footer already counts PRs: show how many sandboxes the work used instead.
        { value: compact(h.boxes), label: one(h.boxes, 'sandbox used', 'sandboxes used') };
  const shipped =
    `${compact(h.prsMerged)} ${one(h.prsMerged, 'PR', 'PRs')} merged · ` +
    `${compact(h.commits)} ${one(h.commits, 'commit', 'commits')}\u00a0·\u00a0`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: '34px 64px 26px',
        backgroundColor: OG.paper,
        fontFamily: sans,
        borderBottom: `12px solid ${OG.accent}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {boxMark(OG.ink, 28)}
        <div
          style={{
            display: 'flex',
            fontFamily: mono,
            fontWeight: 600,
            fontSize: 22,
            color: OG.ink,
            marginLeft: 10,
          }}
        >
          agent-box.sh
        </div>
        <div style={{ display: 'flex', marginLeft: 'auto', fontSize: 19, color: OG.muted }}>
          {TAGLINE}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          marginTop: 24,
          fontSize: fit(title, 40, W),
          fontWeight: 600,
          color: OG.ink,
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </div>

      <div style={{ display: 'flex', marginTop: 22, gap: 32 }}>
        <Headline
          value={num(h.peakAtOnce)}
          label={`${one(h.peakAtOnce, 'agent', 'agents')} running at the same time (peak)`}
          color={OG.accent}
          width={400}
        />
        <Headline
          value={num(h.agentHours)}
          label={`${one(h.agentHours, 'hour', 'hours')} of agent work in ${num(h.wallHours)} ${one(h.wallHours, 'hour', 'hours')}`}
          color={OG.ink}
          width={364}
        />
        <Headline value={third.value} label={third.label} color={OG.ink} width={244} />
      </div>

      <div style={{ display: 'flex', marginTop: 26, gap: 40 }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: CHART_W }}>
          <ChartTitle
            title={`Agents at once, ${per}`}
            note={s.peakDay ? `${num(s.maxPeak)} on ${dayMonth(s.peakDay)}` : undefined}
          />
          <PeakChart s={s} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', width: CHART_W }}>
          <ChartTitle
            title={`Agent-hours ${per}, by agent`}
            note={s.partial ? `last ${s.days} days` : undefined}
          />
          <HoursChart s={s} />
          {s.agents.length > 0 && <Legend agents={s.agents} />}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto' }}>
        {providers.map((p, i) => (
          <ProviderAvatar key={p.id} id={p.id} size={30} overlap={i > 0} />
        ))}
        {names.length > 0 && (
          <div
            style={{
              display: 'flex',
              fontFamily: mono,
              fontSize: 16,
              color: OG.muted,
              marginLeft: 10,
            }}
          >
            on {names.join(', ')}
          </div>
        )}
        <div style={{ display: 'flex', marginLeft: 'auto', fontSize: 21, color: INK_2 }}>
          <span>{shipped}</span>
          <span style={{ color: '#1baf7a', fontWeight: 600 }}>+{compact(h.additions)}</span>
          <span style={{ color: OG.faint }}>{'\u00a0/\u00a0'}</span>
          <span style={{ color: '#e34948', fontWeight: 600 }}>-{compact(h.deletions)}</span>
          <span>{'\u00a0lines'}</span>
        </div>
      </div>
    </div>
  );
}

/** The link-preview card of one share. Immutable, so cached for a year. */
export async function renderShareOg(share: UsageShare): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  // Missing fonts render a fallback face: cache that briefly, never as the share's image.
  const cache =
    fonts.length === 4
      ? 'public, max-age=31536000, s-maxage=31536000, immutable'
      : 'public, max-age=60, s-maxage=60';
  return new ImageResponse(<OgCard share={share} />, {
    ...OG_SIZE,
    fonts: fonts.length ? fonts : undefined,
    headers: { 'Cache-Control': cache },
  });
}
