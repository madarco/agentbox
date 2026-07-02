'use client';

import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
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
    <div className="grid min-h-screen grid-cols-[232px_minmax(0,1fr)] max-md:grid-cols-1">
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
  return (
    <HubProvider data={data}>
      <ShellFrame>{children}</ShellFrame>
    </HubProvider>
  );
}
