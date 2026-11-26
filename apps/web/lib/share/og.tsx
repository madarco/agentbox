import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import { decodeWall } from '@agentbox/usage-view';
import type { ProviderId, UsageShare } from '@agentbox/usage-view';
import { OG, boxMark, loadOgFonts } from '@/lib/og';
import { hoursText, num, rangeText, speedup } from './format';

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_ALT = 'Usage shared from AgentBox: agents at once, hours of work, what shipped';

const mono = 'IBM Plex Mono';
const sans = 'IBM Plex Sans';

// The activity wall's ramp (packages/usage-view usage.css --w0..--w5).
const WALL = ['#ebebe6', '#c3e6cf', '#86cfa2', '#3fae72', '#128a4f', '#0a5c34'];
const WEEKS = 20;

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

/** Font size that keeps `text` on one line within `width` (Plex at ~0.56em per glyph). */
const fit = (text: string, max: number, width: number): number =>
  Math.min(max, Math.floor(width / (text.length * 0.55)));

/** 9,999,999 stays readable on a tile up to 6 digits, then 1.2M. */
const compact = (v: number): string =>
  v < 1_000_000 ? num(v) : `${(Math.floor(v / 100_000) / 10).toFixed(1)}M`;

/** The last WEEKS full columns of the wall, Sunday on top, as ramp levels 0..5. */
function wallColumns(share: UsageShare): number[][] {
  const days = decodeWall(share.wall).filter((d) => d.date <= share.range.today);
  const last = days.at(-1);
  if (!last) return Array.from({ length: WEEKS }, () => Array<number>(7).fill(-1));
  const vals = days.map((d) => d.all);
  const sorted = vals.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))] ?? 1;
  const cuts = [q(0.2), q(0.45), q(0.7), q(0.9)];
  const level = (v: number): number => (v <= 0 ? 0 : 1 + cuts.filter((c) => v > c).length);

  const lastDow = new Date(`${last.date}T00:00:00Z`).getUTCDay();
  // Grid slot k (0 = top-left) maps to the day `total - 1 - k` steps before the last one.
  const total = WEEKS * 7 - (6 - lastDow);
  const byOffset = new Map<number, number>();
  days.forEach((d, i) => byOffset.set(days.length - 1 - i, level(d.all)));
  const cols: number[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const col: number[] = [];
    for (let r = 0; r < 7; r++) {
      const k = w * 7 + r;
      // -1: after today (blank); a day before the data starts is an empty square.
      col.push(k >= total ? -1 : (byOffset.get(total - 1 - k) ?? 0));
    }
    cols.push(col);
  }
  return cols;
}

function WallStrip({ share }: { share: UsageShare }) {
  const cell = 15;
  const gap = 4;
  return (
    <div style={{ display: 'flex', gap }}>
      {wallColumns(share).map((col, w) => (
        <div key={w} style={{ display: 'flex', flexDirection: 'column', gap }}>
          {col.map((lv, r) => (
            <div
              key={r}
              style={{
                display: 'flex',
                width: cell,
                height: cell,
                borderRadius: 3,
                backgroundColor: lv < 0 ? 'transparent' : WALL[lv],
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Stat({
  value,
  label,
  color,
}: {
  value: ReactElement | string;
  label: string;
  color?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          fontFamily: sans,
          fontWeight: 600,
          fontSize: 40,
          color: color ?? OG.ink,
          letterSpacing: '-0.02em',
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      <div
        style={{ display: 'flex', fontFamily: mono, fontSize: 17, color: OG.muted, marginTop: 6 }}
      >
        {label}
      </div>
    </div>
  );
}

function OgCard({ share }: { share: UsageShare }) {
  const h = share.hero;
  const peak = `${num(h.peakAtOnce)}`;
  // Satori trims spaces at span edges, so the joins are non-breaking spaces.
  const peakRest = num(h.peakAtOnce) === '1' ? '\u00a0agent at once' : '\u00a0agents at once';
  const heroSize = fit(peak + peakRest, 112, 1072);
  const hoursA = hoursText(share);
  // One agent at a time is no speed-up: leave the claim out rather than print "1x faster".
  const hoursB = h.speedup >= 1.1 ? `\u00a0·\u00a0${speedup(h.speedup)} faster` : '';
  const subSize = fit(hoursA + hoursB, 42, 1072);
  const providers = [...share.providers].sort((a, b) => b.hours - a.hours).slice(0, 3);
  const names = providers.map((p) => PROVIDER[p.id].label);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: '44px 64px 34px',
        backgroundColor: OG.paper,
        fontFamily: sans,
        borderBottom: `16px solid ${OG.accent}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {boxMark(OG.ink, 34)}
        <div
          style={{
            display: 'flex',
            fontFamily: mono,
            fontWeight: 600,
            fontSize: 25,
            color: OG.ink,
            marginLeft: 12,
          }}
        >
          agent-box.sh
        </div>
        <div
          style={{
            display: 'flex',
            marginLeft: 'auto',
            fontFamily: mono,
            fontSize: 20,
            color: OG.muted,
          }}
        >
          {rangeText(share)}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40 }}>
        <div
          style={{
            display: 'flex',
            fontSize: heroSize,
            fontWeight: 600,
            color: OG.ink,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
          }}
        >
          <span style={{ color: OG.accent }}>{peak}</span>
          <span>{peakRest}</span>
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: subSize,
            color: '#3d434c',
            marginTop: 12,
            letterSpacing: '-0.01em',
          }}
        >
          <span>{hoursA}</span>
          <span style={{ color: OG.accent, fontWeight: 600 }}>{hoursB}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div style={{ display: 'flex', gap: 44 }}>
            <Stat
              value={compact(h.prsMerged)}
              label={num(h.prsMerged) === '1' ? 'PR merged' : 'PRs merged'}
            />
            <Stat
              value={compact(h.commits)}
              label={num(h.commits) === '1' ? 'commit' : 'commits'}
            />
            <Stat
              value={
                <div style={{ display: 'flex' }}>
                  <span style={{ color: '#1baf7a' }}>+{compact(h.additions)}</span>
                  <span style={{ color: OG.faint, margin: '0 10px' }}>/</span>
                  <span style={{ color: '#e34948' }}>-{compact(h.deletions)}</span>
                </div>
              }
              label="lines"
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {providers.map((p, i) => (
              <ProviderAvatar key={p.id} id={p.id} size={40} overlap={i > 0} />
            ))}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                marginLeft: providers.length ? 14 : 0,
              }}
            >
              <div style={{ display: 'flex', fontSize: 25, fontWeight: 600, color: OG.ink }}>
                {share.handle}
              </div>
              {names.length > 0 && (
                <div style={{ display: 'flex', fontFamily: mono, fontSize: 16, color: OG.muted }}>
                  on {names.join(', ')}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 'auto', gap: 10 }}>
          <div style={{ display: 'flex', fontFamily: mono, fontSize: 15, color: OG.faint }}>
            last {WEEKS} weeks
          </div>
          <WallStrip share={share} />
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
