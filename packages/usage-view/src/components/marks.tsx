import type { ReactElement } from 'react';
import type { AgentId, ProviderId } from '../schema.js';
import { AGENT_LOGOS } from './agent-logos.js';
import { AGENT_COLOR, PROVIDER_LABEL } from './format.js';

// Stand-in marks in each provider's brand colour, as in the approved mockup.
const PROVIDER_MARK: Record<ProviderId, [string, ReactElement]> = {
  docker: [
    '#1d63ed',
    <g fill="#fff">
      <rect x="5" y="10" width="3" height="3" rx=".5" />
      <rect x="8.6" y="10" width="3" height="3" rx=".5" />
      <rect x="12.2" y="10" width="3" height="3" rx=".5" />
      <rect x="8.6" y="6.4" width="3" height="3" rx=".5" />
      <rect x="12.2" y="6.4" width="3" height="3" rx=".5" />
      <path d="M4 14h13.5c.8-1.6 2.2-2.2 3-2-.2 1-.9 1.6-1.6 1.9C17.8 17 15 19 10.5 19 6.5 19 4.6 17 4 14z" />
    </g>,
  ],
  hetzner: ['#d50c2d', <path fill="#fff" d="M7 6h3v4.6h4V6h3v12h-3v-4.6h-4V18H7z" />],
  daytona: [
    '#16181c',
    <path fill="none" stroke="#fff" strokeWidth="2.4" d="M8 6.5h3.5a5.5 5.5 0 010 11H8z" />,
  ],
  vercel: ['#000', <path fill="#fff" d="M12 6.5l6.5 11h-13z" />],
  e2b: [
    '#ff8800',
    <text
      x="12"
      y="15.2"
      textAnchor="middle"
      fontFamily="IBM Plex Mono, monospace"
      fontWeight="600"
      fontSize="8"
      style={{ fill: '#fff' }}
    >
      e2b
    </text>,
  ],
  'remote-docker': [
    '#3d434c',
    <>
      <g fill="none" stroke="#fff" strokeWidth="1.8">
        <rect x="5.5" y="6" width="13" height="5" rx="1.2" />
        <rect x="5.5" y="13" width="13" height="5" rx="1.2" />
      </g>
      <g fill="#fff">
        <circle cx="8.5" cy="8.5" r="1" />
        <circle cx="8.5" cy="15.5" r="1" />
      </g>
    </>,
  ],
  digitalocean: [
    '#0069ff',
    <path
      fill="#fff"
      d="M12 18.5v-2.7a3.8 3.8 0 10-3.8-3.8H5.5A6.5 6.5 0 1112 18.5zM9.3 16.3H12V19H9.3zM7.2 18.4h2.1v2.1H7.2zM7.2 14.2H9.3v2.1H7.2z"
    />,
  ],
  host: [
    '#5b616b',
    <g fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round">
      <rect x="5" y="6.5" width="14" height="9" rx="1.5" />
      <path d="M9 18.5h6" />
    </g>,
  ],
  other: [
    '#a4a9b0',
    <g fill="#fff">
      <circle cx="8" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="16" cy="12" r="1.4" />
    </g>,
  ],
};

export function ProviderLogo({ id, size }: { id: ProviderId; size: number }): ReactElement {
  const [bg, mark] = PROVIDER_MARK[id];
  return (
    <svg
      className="plogo"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={PROVIDER_LABEL[id]}
    >
      <circle cx="12" cy="12" r="12" fill={bg} />
      {mark}
    </svg>
  );
}

export function AgentIcon({ agent, size = 18 }: { agent: AgentId; size?: number }): ReactElement {
  const src = AGENT_LOGOS[agent];
  if (src) return <img src={src} alt="" width={size} height={size} />;
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        flex: 'none',
        display: 'inline-block',
        background: AGENT_COLOR[agent],
      }}
    />
  );
}

/** For inside an SVG (the Gantt's lane labels). */
export function AgentGlyph({
  agent,
  x,
  y,
  size,
}: {
  agent: AgentId;
  x: number;
  y: number;
  size: number;
}): ReactElement {
  const src = AGENT_LOGOS[agent];
  if (src) return <image href={src} x={x} y={y} width={size} height={size} />;
  return (
    <circle
      cx={x + size / 2}
      cy={y + size / 2}
      r={size / 2 - 1}
      style={{ fill: AGENT_COLOR[agent] }}
    />
  );
}

const icon = (children: ReactElement): ReactElement => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

export const Icons = {
  lanes: icon(
    <>
      <rect x="3" y="4" width="18" height="4" rx="1.5" />
      <rect x="3" y="10" width="13" height="4" rx="1.5" />
      <rect x="3" y="16" width="16" height="4" rx="1.5" />
    </>,
  ),
  pr: icon(
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M8 6h5a5 5 0 015 5v4.5" />
    </>,
  ),
  clock: icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
  ),
  flame: icon(<path d="M12 2c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" />),
  bolt: icon(<path d="M13 2L4 14h7l-1 8 9-12h-7z" />),
  box: icon(
    <>
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>,
  ),
  info: icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4m0 4h.01" />
    </>,
  ),
};
