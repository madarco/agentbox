'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Fragment, useEffect, useState } from 'react';
import { CommandPalette } from '@/components/command-palette';
import { Icons } from '@/components/icons';
import { toggleNav, toggleSidebar } from '@/components/shell-state';
import { SubsIndicator } from '@/components/subs-indicator';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { useStore } from '@/lib/boxes/store';

interface Crumb {
  label: string;
  to?: string;
}

const SETTINGS_LABEL: Record<string, string> = {
  subscriptions: 'subscriptions',
  skills: 'skills',
  files: 'files',
  devices: 'devices',
  system: 'system',
};

function useCrumbs(): Crumb[] {
  const pathname = usePathname();
  const { project, box } = useStore();
  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] === 'projects' && seg[1]) {
    const p = project(seg[1]);
    return [{ label: 'projects' }, { label: p ? p.name : 'project' }];
  }
  if (seg[0] === 'boxes' && seg[1]) {
    const b = box(decodeURIComponent(seg[1]));
    const p = b ? project(b.projectId) : undefined;
    return [
      { label: 'boxes', to: '/' },
      ...(p ? [{ label: p.name, to: '/projects/' + p.id }] : []),
      { label: b ? b.name || b.id : 'box' },
    ];
  }
  if (seg[0] === 'settings') {
    return [
      { label: 'settings', to: seg[1] ? '/settings' : undefined },
      { label: seg[1] ? (SETTINGS_LABEL[seg[1]] ?? seg[1]) : 'general' },
    ];
  }
  if (seg[0] === 'approvals' || seg[0] === 'usage') return [{ label: seg[0] }];
  return [{ label: 'boxes' }];
}

function Breadcrumbs() {
  const items = useCrumbs();
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-2 font-mono text-[12.5px] text-muted-foreground/80"
    >
      <Link className="hover:text-primary" href="/">
        hub
      </Link>
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={i}>
            <span className={last ? 'text-border' : 'text-border max-sm:hidden'}>/</span>
            {last ? (
              <span aria-current="page" className="truncate font-medium text-secondary-foreground">
                {c.label}
              </span>
            ) : c.to ? (
              <Link className="truncate transition-colors hover:text-primary max-sm:hidden" href={c.to}>
                {c.label}
              </Link>
            ) : (
              <span className="truncate max-sm:hidden">{c.label}</span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // The resolved theme is only known in the browser: render a neutral icon on
  // the server pass so hydration matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <Icons.sun /> : <Icons.moon />}
    </Button>
  );
}

export function Topbar() {
  const { state } = useStore();
  const [cmdk, setCmdk] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setCmdk((v) => !v);
      } else if (k === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="sticky top-[var(--banner-h,0px)] z-30 flex h-14 flex-none items-center gap-2 rounded-t-xl border-b border-border bg-background/80 px-4 backdrop-blur-md max-md:rounded-none">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Toggle sidebar"
        title="Toggle sidebar (⌘B)"
        onClick={toggleNav}
      >
        <Icons.panel />
      </Button>
      <Separator vertical className="mr-1" />
      <Breadcrumbs />
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => setCmdk(true)}
        aria-label="Search"
        className="inline-flex h-8 w-60 cursor-pointer items-center gap-2 rounded-md border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent max-lg:w-auto"
      >
        <Icons.search className="size-4" />
        <span className="max-lg:hidden">Search…</span>
        <Kbd className="ml-auto max-lg:hidden">⌘K</Kbd>
      </button>
      {state.controlPlane ? (
        <Button
          variant="ghost"
          size="sm"
          className="max-md:hidden"
          href={state.controlPlane.url}
          target="_blank"
          rel="noopener"
          title={`This hub operates through the control box at ${state.controlPlane.url}`}
        >
          <Icons.server />
          Control box
        </Button>
      ) : null}
      <div className="max-sm:hidden">
        <SubsIndicator />
      </div>
      <ThemeToggle />
      {cmdk ? <CommandPalette onClose={() => setCmdk(false)} /> : null}
    </header>
  );
}
