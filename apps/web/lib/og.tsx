import type { ReactElement } from 'react';

// Home-page theme tokens (public/home.html :root) so OG images match the site.
export const OG = {
  paper: '#f6f6f3',
  panel: '#ffffff',
  ink: '#16181c',
  muted: '#7b818b',
  faint: '#a4a9b0',
  line: '#e3e3dd',
  accent: '#128a4f',
  accentSoft: '#eaf4ee',
  term: '#0e1218',
  termText: '#c8ccd3',
  termFaint: '#7c828c',
} as const;

// IBM Plex (the site's typefaces) as raw TTF for satori — Google Fonts serves
// woff2, which satori can't parse; the IBM/plex repo ships complete TTFs.
const PLEX = 'https://cdn.jsdelivr.net/gh/IBM/plex@v6.4.0';
const FONT_URLS = {
  sans400: `${PLEX}/IBM-Plex-Sans/fonts/complete/ttf/IBMPlexSans-Regular.ttf`,
  sans600: `${PLEX}/IBM-Plex-Sans/fonts/complete/ttf/IBMPlexSans-SemiBold.ttf`,
  mono400: `${PLEX}/IBM-Plex-Mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf`,
  mono600: `${PLEX}/IBM-Plex-Mono/fonts/complete/ttf/IBMPlexMono-SemiBold.ttf`,
} as const;

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: 'normal';
}

async function fetchFont(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// Fetch once per server process; satori tolerates missing fonts (falls back to
// a built-in sans) so a flaky CDN degrades gracefully rather than failing build.
let fontsPromise: Promise<OgFont[]> | null = null;
export function loadOgFonts(): Promise<OgFont[]> {
  fontsPromise ??= (async () => {
    const [sans400, sans600, mono400, mono600] = await Promise.all([
      fetchFont(FONT_URLS.sans400),
      fetchFont(FONT_URLS.sans600),
      fetchFont(FONT_URLS.mono400),
      fetchFont(FONT_URLS.mono600),
    ]);
    const fonts: OgFont[] = [];
    if (sans400)
      fonts.push({ name: 'IBM Plex Sans', data: sans400, weight: 400, style: 'normal' });
    if (sans600)
      fonts.push({ name: 'IBM Plex Sans', data: sans600, weight: 600, style: 'normal' });
    if (mono400)
      fonts.push({ name: 'IBM Plex Mono', data: mono400, weight: 400, style: 'normal' });
    if (mono600)
      fonts.push({ name: 'IBM Plex Mono', data: mono600, weight: 600, style: 'normal' });
    return fonts;
  })();
  return fontsPromise;
}

// Brand icons as data URIs so satori can inline them (it can't reliably fetch
// remote images at render time). SVGs come from Simple Icons tinted to ink;
// agent glyphs are the local PNGs the home page uses. Memoized per process.
const iconCache = new Map<string, Promise<string | null>>();

export function simpleIcon(slug: string): Promise<string | null> {
  const key = `si:${slug}`;
  if (!iconCache.has(key)) {
    iconCache.set(
      key,
      (async () => {
        try {
          const res = await fetch(`https://cdn.simpleicons.org/${slug}/16181c`);
          if (!res.ok) return null;
          const svg = await res.text();
          return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
        } catch {
          return null;
        }
      })(),
    );
  }
  return iconCache.get(key)!;
}

export function localPng(relPathFromPublic: string): Promise<string | null> {
  const key = `png:${relPathFromPublic}`;
  if (!iconCache.has(key)) {
    iconCache.set(
      key,
      (async () => {
        try {
          const { readFile } = await import('node:fs/promises');
          const { join } = await import('node:path');
          const buf = await readFile(join(process.cwd(), 'public', relPathFromPublic));
          return `data:image/png;base64,${buf.toString('base64')}`;
        } catch {
          return null;
        }
      })(),
    );
  }
  return iconCache.get(key)!;
}

// A simple 3D cube (Daytona has no Simple Icon; mirrors home.html's #i-cube).
export function cubeMark(color: string, size = 22): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M12 12 21 7M12 12v10M12 12 3 7" />
    </svg>
  );
}

// The AgentBox box mark (public/logo.svg), tintable to sit on light or dark.
export function boxMark(color: string, size = 60): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 385 382" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M325 16H59C35.804 16 17 34.804 17 58V324C17 347.196 35.804 366 59 366H325C348.196 366 367 347.196 367 324V58C367 34.804 348.196 16 325 16Z"
        fill="none"
        stroke={color}
        strokeWidth="31"
      />
      <path d="M255 191H129V317H255V191Z" stroke={color} strokeWidth="10" />
      <path d="M236 210H148V298H236V210Z" fill={color} />
    </svg>
  );
}
