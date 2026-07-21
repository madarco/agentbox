import type { ReactNode } from 'react';
import { HubShell } from '@/components/hub-shell';
import { getDashboardData } from '@/lib/boxes/source';

// Read the host box state fresh on every request (relay lifecycle mutates it).
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const data = await getDashboardData();
  return <HubShell data={data}>{children}</HubShell>;
}
