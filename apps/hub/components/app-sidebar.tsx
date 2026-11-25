'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icons, type Icon } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useAccounts } from '@/lib/accounts-client';
import { useStore } from '@/lib/boxes/store';

function SideItem({
  active,
  to,
  href,
  icon: IconComp,
  label,
  count,
  note,
  ext,
  child,
}: {
  active?: boolean;
  to?: string;
  href?: string;
  icon?: Icon;
  label: ReactNode;
  count?: number;
  /** A short warning in place of a count (`1 at limit`). */
  note?: string;
  ext?: boolean;
  /** Nested under a parent item: smaller, no icon. */
  child?: boolean;
}) {
  const className = cn(
    'flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 text-left transition-colors',
    child ? 'py-[5px] text-[13px]' : 'py-[7px] text-[13.5px]',
    active
      ? 'bg-accent font-medium text-accent-foreground'
      : 'text-secondary-foreground hover:bg-secondary hover:text-foreground',
  );
  const inner = (
    <>
      {IconComp ? (
        <IconComp
          className={cn('size-4 flex-none', active ? 'text-primary' : 'text-muted-foreground')}
        />
      ) : null}
      {label}
      {count !== undefined ? <Count active={active}>{count}</Count> : null}
      {note ? <span className="ml-auto font-mono text-[10.5px] text-[#6a4e0c]">{note}</span> : null}
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
    <Link className={className} href={to ?? '#'} aria-current={active ? 'page' : undefined}>
      {inner}
    </Link>
  );
}

function Count({ active, children }: { active?: boolean; children: ReactNode }) {
  return (
    <Badge
      className={cn(
        'ml-auto border-transparent px-2 py-0 text-[11px]',
        active ? 'bg-card text-primary' : 'bg-secondary text-[#a4a9b0]',
      )}
    >
      {children}
    </Badge>
  );
}

type SubItem = { to: string; label: string; count?: number; note?: string; exact?: boolean };

function onRoute(pathname: string, to: string, exact?: boolean): boolean {
  return pathname === to || (!exact && pathname.startsWith(to + '/'));
}

/**
 * A top-level item with nested links. It opens while the user is on one of its
 * routes and closes when they leave; the chevron toggles it in between. The
 * parent link is a route of its own (its first child), so it carries
 * `aria-current` only when the children are hidden and it stands in for them.
 */
function SideGroup({
  to,
  icon: IconComp,
  label,
  items,
}: {
  to: string;
  icon: Icon;
  label: string;
  items: SubItem[];
}) {
  const pathname = usePathname();
  const within = onRoute(pathname, to);
  // A manual toggle holds until the user navigates into or out of the group,
  // where it is dropped (state adjusted during render, React's pattern for
  // resetting state on a prop change).
  const [open, setOpen] = useState(within);
  const [wasWithin, setWasWithin] = useState(within);
  if (wasWithin !== within) {
    setWasWithin(within);
    setOpen(within);
  }
  const listId = useId();
  const highlight = within && !open;

  return (
    <div>
      <div
        className={cn(
          'flex items-center rounded-lg transition-colors',
          highlight
            ? 'bg-accent text-accent-foreground'
            : 'text-secondary-foreground hover:bg-secondary hover:text-foreground',
        )}
      >
        <Link
          href={to}
          aria-current={highlight ? 'page' : undefined}
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-[7px] text-left text-[13.5px]',
            within && 'font-medium text-foreground',
          )}
        >
          <IconComp
            className={cn('size-4 flex-none', within ? 'text-primary' : 'text-muted-foreground')}
          />
          {label}
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          onClick={() => setOpen(!open)}
          className="mr-1 grid size-6 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[#a4a9b0] hover:text-foreground"
        >
          <Icons.chevR className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
      </div>
      {open ? (
        <div
          id={listId}
          className="mb-1 ml-[15px] mt-px flex flex-col gap-px border-l border-border pl-2"
        >
          {items.map((it) => (
            <SideItem
              key={it.to}
              child
              active={onRoute(pathname, it.to, it.exact)}
              to={it.to}
              label={it.label}
              count={it.count}
              note={it.note}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SideLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1.5 pt-4 font-mono text-[10.5px] uppercase tracking-[.1em] text-[#a4a9b0]">
      {children}
    </div>
  );
}

const SETTINGS: SubItem[] = [
  { to: '/settings', label: 'General', exact: true },
  { to: '/settings/subscriptions', label: 'Subscriptions' },
  { to: '/settings/skills', label: 'Skills' },
  { to: '/settings/files', label: 'Files' },
  { to: '/settings/devices', label: 'Devices' },
  { to: '/settings/system', label: 'System' },
];

export function AppSidebar() {
  const { state, boxesFor } = useStore();
  const { accounts } = useAccounts();
  const atLimit = (accounts ?? []).filter((x) => x.limits?.atLimit).length;
  const settingsItems = SETTINGS.map((it) =>
    it.to === '/settings/subscriptions' && atLimit > 0
      ? { ...it, note: `${String(atLimit)} at limit` }
      : it,
  );
  const pathname = usePathname();
  const dashActive = pathname === '/' || pathname.startsWith('/boxes');

  return (
    <aside className="shad-side sticky top-[var(--banner-h,0px)] z-50 flex h-[calc(100vh-var(--banner-h,0px))] flex-col self-start overflow-y-auto border-r border-border bg-background px-3.5 pb-4 pt-4 max-md:w-64">
      <div className="flex items-center gap-2.5 px-2 pb-4 font-mono text-sm font-semibold">
        <img src="/logo.svg" alt="" width={20} height={20} className="h-5 w-5" />
        agentbox
        <span className="font-normal text-[#a4a9b0]">/ hub</span>
      </div>

      <SideLabel>Workspace</SideLabel>
      <nav className="flex flex-col gap-px">
        <SideItem
          active={dashActive}
          to="/"
          icon={Icons.grid}
          label="Dashboard"
          count={state.boxes.length}
        />
        <SideItem
          active={onRoute(pathname, '/approvals')}
          to="/approvals"
          icon={Icons.shield}
          label="Approvals"
          count={state.approvals.length}
        />
        <SideItem
          active={onRoute(pathname, '/usage')}
          to="/usage"
          icon={Icons.activity}
          label="Usage"
        />
        <SideGroup to="/settings" icon={Icons.settings} label="Settings" items={settingsItems} />
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
            <span className="block font-mono text-[11px] text-muted-foreground">
              @{state.user.login}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
