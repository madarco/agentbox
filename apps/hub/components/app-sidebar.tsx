'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icons, type Icon } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useStore } from '@/lib/boxes/store';

function SideItem({
  active,
  to,
  href,
  icon: IconComp,
  label,
  count,
  ext,
}: {
  active?: boolean;
  to?: string;
  href?: string;
  icon: Icon;
  label: ReactNode;
  count?: number;
  ext?: boolean;
}) {
  const className = cn(
    'flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 py-[7px] text-left text-[13.5px] transition-colors',
    active ? 'bg-accent font-medium text-accent-foreground' : 'text-secondary-foreground hover:bg-secondary hover:text-foreground',
  );
  const inner = (
    <>
      <IconComp className={cn('size-4 flex-none', active ? 'text-primary' : 'text-muted-foreground')} />
      {label}
      {count !== undefined ? (
        <Badge className={cn('ml-auto border-transparent px-2 py-0 text-[11px]', active ? 'bg-card text-primary' : 'bg-secondary text-[#a4a9b0]')}>
          {count}
        </Badge>
      ) : null}
      {ext ? <Icons.ext className="ml-auto size-[13px] text-[#a4a9b0]" /> : null}
    </>
  );

  if (href) {
    return (
      <a className={className} href={href} target="_blank" rel="noopener">
        {inner}
      </a>
    );
  }
  return (
    <Link className={className} href={to ?? '#'}>
      {inner}
    </Link>
  );
}

function SideLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1.5 pt-4 font-mono text-[10.5px] uppercase tracking-[.1em] text-[#a4a9b0]">{children}</div>;
}

export function AppSidebar() {
  const { state, boxesFor } = useStore();
  const pathname = usePathname();
  const dashActive = pathname === '/' || pathname.startsWith('/boxes');

  return (
    <aside className="shad-side sticky top-0 z-50 flex h-screen flex-col self-start overflow-y-auto border-r border-border bg-background px-3.5 pb-4 pt-4 max-md:w-64">
      <div className="flex items-center gap-2.5 px-2 pb-4 font-mono text-sm font-semibold">
        <img src="/logo.svg" alt="" width={20} height={20} className="h-5 w-5" />
        agentbox
        <span className="font-normal text-[#a4a9b0]">/ control</span>
      </div>

      <SideLabel>Workspace</SideLabel>
      <nav className="flex flex-col gap-px">
        <SideItem active={dashActive} to="/" icon={Icons.grid} label="Dashboard" count={state.boxes.length} />
        <SideItem
          active={pathname.startsWith('/approvals')}
          to="/approvals"
          icon={Icons.shield}
          label="Approvals"
          count={state.approvals.length}
        />
        <SideItem active={pathname.startsWith('/settings')} to="/settings" icon={Icons.settings} label="Settings" />
        <SideItem href="https://agent-box.sh/docs" icon={Icons.book} label="Docs" ext />
        <SideItem href="/api/v1/docs" icon={Icons.terminal} label="API" ext />
      </nav>

      <SideLabel>Projects</SideLabel>
      <nav className="flex flex-col gap-px">
        {state.projects.map((p) => (
          <SideItem
            key={p.id}
            active={pathname === '/projects/' + p.id}
            to={'/projects/' + p.id}
            icon={Icons.folder}
            label={p.name}
            count={boxesFor(p.id).length}
          />
        ))}
      </nav>

      <div className="mt-auto border-t border-border pt-2.5">
        <div className="flex items-center gap-2.5 px-1.5 pt-1.5">
          <Avatar fallback="M" />
          <div className="text-[12.5px] leading-tight">
            {state.user.name}
            <span className="block font-mono text-[11px] text-muted-foreground">@{state.user.login}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
