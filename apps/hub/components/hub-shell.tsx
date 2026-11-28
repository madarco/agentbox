'use client';

import { usePathname } from 'next/navigation';
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { LinkedHubBanner } from '@/components/linked-hub-banner';
import { LiveRefresh } from '@/components/live-refresh';
import { Topbar } from '@/components/topbar';
import { HubProvider } from '@/lib/boxes/store';
import type { HubState } from '@/lib/boxes/types';

function ShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // close the mobile drawer on navigation
  useEffect(() => {
    document.body.classList.remove('nav-open');
  }, [pathname]);

  return (
    <div className="app-grid grid min-h-[calc(100vh-var(--banner-h,0px))] bg-sidebar">
      <div
        className="pointer-events-none fixed inset-0 z-40 bg-black/50 opacity-0 transition-opacity [body.nav-open_&]:pointer-events-auto [body.nav-open_&]:opacity-100"
        onClick={() => document.body.classList.remove('nav-open')}
      />
      <AppSidebar />
      {/* The page sits on a raised panel inset from the sidebar's paper. */}
      <main className="flex min-h-[calc(100vh-var(--banner-h,0px)-1rem)] min-w-0 flex-col rounded-xl border border-black/[.06] bg-background shadow-sm md:my-2 md:mr-2 dark:border-white/[.08] max-md:rounded-none max-md:border-0">
        <Topbar />
        <div className="min-w-0 flex-1">{children}</div>
      </main>
    </div>
  );
}

export function HubShell({ data, children }: { data: HubState; children: ReactNode }) {
  // The linked-hub banner stays pinned above the topbar, so everything else that
  // sticks to the viewport top has to start below it. One variable keeps the
  // banner's own height and that offset from drifting apart.
  const style = { '--banner-h': data.controlPlane ? '36px' : '0px' } as CSSProperties;
  return (
    <HubProvider data={data}>
      <LiveRefresh />
      <div style={style}>
        <LinkedHubBanner />
        <ShellFrame>{children}</ShellFrame>
      </div>
    </HubProvider>
  );
}
