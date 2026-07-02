'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Box, HubState, Project, Repo } from './types';

// Read-only data context. The dashboard layout (a server component) reads the
// host state and passes it in as `data`; a lifecycle server action +
// router.refresh() re-runs the layout, so the context always reflects the
// latest server render (no client-side mutation, no mock store).
interface HubContextValue {
  state: HubState;
  project: (id: string) => Project | undefined;
  box: (id: string) => Box | undefined;
  boxesFor: (pid: string) => Box[];
  repo: (full: string) => Repo | undefined;
}

const HubContext = createContext<HubContextValue | null>(null);

export function HubProvider({ data, children }: { data: HubState; children: ReactNode }) {
  const value = useMemo<HubContextValue>(
    () => ({
      state: data,
      project: (id) => data.projects.find((p) => p.id === id),
      box: (id) => data.boxes.find((b) => b.id === id),
      boxesFor: (pid) => data.boxes.filter((b) => b.projectId === pid),
      repo: (full) => data.github.repos.find((r) => r.full === full),
    }),
    [data],
  );
  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

export function useStore(): HubContextValue {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error('useStore must be used within HubProvider');
  return ctx;
}
