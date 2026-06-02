import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { FullSearchTrigger } from 'fumadocs-ui/layouts/shared/slots/search-trigger';
import type { ReactNode } from 'react';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  const base = baseOptions();
  return (
    <DocsLayout
      {...base}
      // Full-width sticky top navbar (brand left; github + version pill right),
      // sidebar below — matches the AgentBox Docs mockup.
      nav={{ ...base.nav, mode: 'top' }}
      // Search lives at the top of the sidebar (like the mockup), not the navbar.
      // The element needs a `key`: fumadocs' notebook Sidebar renders the banner
      // inside a keyless array (`[children, banner]`), so without one React warns.
      // (An FC banner would avoid the array but can't cross the server/client
      // boundary as a function prop.)
      sidebar={{
        banner: <FullSearchTrigger key="agb-search" className="agb-search" />,
      }}
      tree={source.pageTree}
    >
      {children}
    </DocsLayout>
  );
}
