'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth.client';
import { useStore } from '@/lib/boxes/store';

function Crumb({ to, children, current }: { to?: string; children: ReactNode; current?: boolean }) {
  if (current) {
    return <b className="overflow-hidden text-ellipsis whitespace-nowrap font-medium text-secondary-foreground">{children}</b>;
  }
  return (
    <Link className="cursor-pointer hover:text-primary" href={to ?? '#'}>
      {children}
    </Link>
  );
}

function Sep() {
  return <span className="text-border">/</span>;
}

function Crumbs() {
  const pathname = usePathname();
  const { project, box } = useStore();
  const parts: ReactNode[] = [
    <Crumb key="h" to="/">
      hub
    </Crumb>,
  ];

  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] === 'projects' && seg[1]) {
    const p = project(seg[1]);
    parts.push(<Sep key="s1" />, <Crumb key="p" current>{p ? p.name : 'project'}</Crumb>);
  } else if (seg[0] === 'boxes' && seg[1]) {
    const b = box(seg[1]);
    const p = b ? project(b.projectId) : undefined;
    if (p) parts.push(<Sep key="s1" />, <Crumb key="p" to={'/projects/' + p.id}>{p.name}</Crumb>);
    parts.push(<Sep key="s2" />, <Crumb key="b" current>{b ? b.id : 'box'}</Crumb>);
  } else if (seg[0] === 'settings') {
    parts.push(<Sep key="s1" />, <Crumb key="se" current>settings</Crumb>);
  } else {
    parts.push(<Sep key="s1" />, <Crumb key="d" current>dashboard</Crumb>);
  }

  return <div className="flex min-w-0 items-center gap-2 font-mono text-[12.5px] text-[#a4a9b0]">{parts}</div>;
}

export function Topbar() {
  const router = useRouter();
  const { state } = useStore();
  return (
    <div className="sticky top-0 z-30 flex h-[54px] items-center gap-3 border-b border-border bg-[rgba(246,246,243,.86)] px-6 backdrop-blur-md">
      <Button
        variant="outline"
        size="icon-sm"
        className="hidden max-md:inline-flex"
        aria-label="Menu"
        onClick={() => document.body.classList.toggle('nav-open')}
      >
        <Icons.menu />
      </Button>
      <Crumbs />
      <span className="flex-1" />
      {state.controlPlane ? (
        <Button
          variant="ghost"
          size="sm"
          href={state.controlPlane.url}
          target="_blank"
          rel="noopener"
          title={`This hub operates through the control box at ${state.controlPlane.url}`}
        >
          <Icons.server />
          Control box
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" href="https://agent-box.sh/docs" target="_blank" rel="noopener">
        <Icons.book />
        Docs
      </Button>
      <Button variant="ghost" size="sm" href="/api/v1/docs" target="_blank" rel="noopener">
        <Icons.terminal />
        API
      </Button>
      {state.authMode === 'password' ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void signOut().then(() => {
              router.push('/signin');
              router.refresh();
            });
          }}
        >
          Sign out
        </Button>
      ) : null}
    </div>
  );
}
