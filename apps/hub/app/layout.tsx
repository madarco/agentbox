import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

// Self-hosted (app/fonts, from @fontsource, OFL) so a build never fetches Google
// Fonts. The design only uses 400/500/600 through font-normal/medium/semibold.
const ibmPlexSans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
});
const ibmPlexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
  adjustFontFallback: false,
});
// The headline accent only (`.serif`).
const instrumentSerif = localFont({
  src: [
    { path: './fonts/instrument-serif-latin-400-italic.woff2', weight: '400', style: 'italic' },
  ],
  variable: '--font-instrument-serif',
  display: 'swap',
});

// Collapsed sidebar before first paint, so a reload does not animate it shut.
// The theme's own pre-paint script comes from next-themes.
const SIDEBAR_SCRIPT = `try{if(localStorage.getItem('hub-sidebar')==='collapsed')document.documentElement.classList.add('sb-collapsed')}catch(e){}`;

export const metadata = {
  title: 'AgentBox hub',
  description: 'Boxes, approvals, and events across machines',
  icons: { icon: [{ url: '/logo.svg', type: 'image/svg+xml' }] },
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_SCRIPT }} />
      </head>
      <body
        className={`${ibmPlexSans.variable} ${ibmPlexMono.variable} ${instrumentSerif.variable} font-sans antialiased`}
      >
        {/* Saved choice per browser (`hub-theme`), else the OS preference. */}
        <ThemeProvider
          attribute="class"
          storageKey="hub-theme"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
