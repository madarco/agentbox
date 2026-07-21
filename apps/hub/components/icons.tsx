import type { ReactElement, SVGProps } from 'react';

// lucide-style stroke icons (24 box) ported from the shadcn prototype
// (../agentbox-design/control-shadcn/icons.jsx). Three brand glyphs
// (claude/codex/opencode) have no lucide equivalent, so the whole set is kept.

export type IconProps = SVGProps<SVGSVGElement>;
export type Icon = (props: IconProps) => ReactElement;

const mk =
  (paths: string[], fill?: boolean): Icon =>
  (props: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );

const codex: Icon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 2.6 3.2 7v10l8.8 4.4L20.8 17V7L12 2.6Zm0 3.1a6.3 6.3 0 1 1 0 12.6 6.3 6.3 0 0 1 0-12.6Zm0 2.4a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8Z" />
  </svg>
);

const github: Icon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 1.5A10.5 10.5 0 0 0 8.7 22c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.3-.3-4.7-1.2-4.7-5.1 0-1.1.4-2 1-2.7-.1-.3-.5-1.4.1-2.8 0 0 .9-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .6 1.4.2 2.5.1 2.8.7.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5Z" />
  </svg>
);

export const Icons = {
  grid: mk(['M4 4h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 13h7v7H4z']),
  box: mk(['M12 20.5 5 17V7l7-3.5L19 7v10Z', 'm5 7 7 3.5L19 7M12 10.5V20']),
  folder: mk(['M4 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z']),
  settings: mk([
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7.5a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
  ]),
  book: mk(['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z']),
  branch: mk([
    'M6 3v12',
    'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M18 9a9 9 0 0 1-9 9',
  ]),
  plus: mk(['M12 5v14M5 12h14']),
  pencil: mk(['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z']),
  pause: mk(['M9 4H6v16h3zM18 4h-3v16h3z']),
  play: mk(['M6 4l14 8-14 8Z']),
  refresh: mk([
    'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
    'M3 3v5h5',
    'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16',
    'M21 21v-5h-5',
  ]),
  stop: mk(['M7 7h10v10H7z']),
  trash: mk(['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6']),
  chevR: mk(['m9 6 6 6-6 6']),
  arrowL: mk(['M19 12H5', 'm12 19-7-7 7-7']),
  arrowUp: mk(['M12 19V5', 'm5 12 7-7 7 7']),
  ext: mk(['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3']),
  copy: mk([
    'M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
    'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  ]),
  x: mk(['M18 6 6 18M6 6l12 12']),
  check: mk(['M20 6 9 17l-5-5']),
  clock: mk(['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z']),
  server: mk(['M3 4h18v6H3zM3 14h18v6H3z', 'M7 7h.01M7 17h.01']),
  host: mk([
    'M5 4h14a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
    'M5 14h14a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2Z',
    'M7 7h.01M7 17h.01',
  ]),
  repo: mk(['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z']),
  search: mk(['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-3.5-3.5']),
  menu: mk(['M4 7h16M4 12h16M4 17h16']),
  terminal: mk(['m6 9 3 3-3 3', 'M13 15h5', 'M4 4h16v16H4z']),
  warn: mk([
    'M10.3 4.3 2.5 18a1.8 1.8 0 0 0 1.6 2.7h15.8A1.8 1.8 0 0 0 21.5 18L13.7 4.3a1.8 1.8 0 0 0-3.1 0Z',
    'M12 9v4M12 17h.01',
  ]),
  activity: mk(['M22 12h-4l-3 9L9 3l-3 9H2']),
  commit: mk(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M3 12h6M15 12h6']),
  file: mk(['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6']),
  shield: mk(['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z']),
  claude: mk(['M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13']),
  codex,
  opencode: mk(['M9 8l-4 4 4 4', 'M15 8l4 4-4 4', 'M13 6l-2 12']),
  github,
} satisfies Record<string, Icon>;

const langColor: Record<string, string> = {
  TypeScript: '#3178c6',
  Go: '#00add8',
  Astro: '#ff5d01',
  MDX: '#f9a03c',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
};

export function LangDot({ lang }: { lang: string }) {
  return (
    <span
      className="inline-block h-2 w-2 flex-none rounded-full"
      style={{ background: langColor[lang] ?? '#9aa0a6' }}
    />
  );
}

export type AgentId = 'claude' | 'codex' | 'opencode' | 'shell';

export const AGENTS: { id: AgentId; label: string; icon: Icon }[] = [
  { id: 'claude', label: 'Claude Code', icon: Icons.claude },
  { id: 'codex', label: 'Codex', icon: Icons.codex },
  { id: 'opencode', label: 'OpenCode', icon: Icons.opencode },
  { id: 'shell', label: 'Shell', icon: Icons.terminal },
];
