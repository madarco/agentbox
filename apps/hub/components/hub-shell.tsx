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
    <div className="grid min-h-[calc(100vh-var(--banner-h,0px))] grid-cols-[232px_minmax(0,1fr)] max-md:grid-cols-1">
      <div
        className="pointer-events-none fixed inset-0 z-40 bg-[rgba(20,24,30,.4)] opacity-0 transition-opacity [body.nav-open_&]:pointer-events-auto [body.nav-open_&]:opacity-100"
        onClick={() => document.body.classList.remove('nav-open')}
      />
      <AppSidebar />
      <main className="flex min-w-0 flex-col">
        <Topbar />
        {children}
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
