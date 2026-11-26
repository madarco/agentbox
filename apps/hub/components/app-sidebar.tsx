'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useId, useState, type ReactNode } from 'react';
import { AddProjectButton } from '@/app/(dashboard)/boxes/components/add-project-modal';
import { Icons, type Icon } from '@/components/icons';
import { useSidebarCollapsed } from '@/components/shell-state';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '@/components/ui/popover';
import { useAccounts } from '@/lib/accounts-client';
import { signOut } from '@/lib/auth.client';
import { useStore } from '@/lib/boxes/store';
import { cn } from '@/lib/utils';

const itemClass = (active: boolean | undefined, sub?: boolean) =>
  cn(
    'sb-center group/item flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
    sub ? 'h-7 px-2 text-[13px]' : 'h-8 px-2 text-sm',
    active
      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground',
  );

function SideItem({
  active,
  to,
  href,
  icon: IconComp,
  label,
  count,
  note,
  sub,
}: {
  active?: boolean;
  /** In-app route. */
  to?: string;
  /** External link, opened in a new tab. */
  href?: string;
  icon?: Icon;
  label: string;
  count?: number;
  /** A short warning in place of a count (`1 at limit`). */
  note?: string;
  sub?: boolean;
}) {
  const inner = (
    <>
      {IconComp ? <IconComp className="size-4 flex-none" /> : null}
      <span className="sb-hide min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="sb-hide ml-auto min-w-5 rounded-md px-1.5 text-center text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
      {note ? (
        <span className="sb-hide ml-auto rounded-md bg-[var(--amber-soft)] px-1.5 text-xs font-medium text-[var(--amber-ink)]">
          {note}
        </span>
      ) : null}
      {href ? <Icons.ext className="sb-hide ml-auto size-3.5 text-muted-foreground" /> : null}
    </>
  );
  if (href) {
    return (
      <a
        className={itemClass(active, sub)}
        href={href}
        target="_blank"
        rel="noopener"
        title={label}
      >
        {inner}
      </a>
    );
  }
  return (
    <Link
      className={itemClass(active, sub)}
      href={to ?? '#'}
      title={label}
      aria-current={active ? 'page' : undefined}
    >
      {inner}
    </Link>
  );
}

function SideGroup({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-2 py-1.5">
      <div className="sb-hide eyebrow flex h-8 items-center px-2">
        {label}
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      <nav aria-label={label} className="flex flex-col gap-0.5">
        {children}
      </nav>
    </div>
  );
}

type SubItem = { to: string; label: string; note?: string; exact?: boolean };

function onRoute(pathname: string, to: string, exact?: boolean): boolean {
  return pathname === to || (!exact && pathname.startsWith(to + '/'));
}

/**
 * An item with nested links. Open while the user is on one of its routes; the
 * header toggles it in between. On the icon rail it is a link to its first
 * child instead.
 */
function NavGroup({
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
  const router = useRouter();
  const collapsed = useSidebarCollapsed();
  const within = onRoute(pathname, to);
  // A manual toggle holds until the user navigates into or out of the group
  // (state adjusted during render, React's pattern for resetting on a prop change).
  const [open, setOpen] = useState(within);
  const [wasWithin, setWasWithin] = useState(within);
  if (wasWithin !== within) {
    setWasWithin(within);
    setOpen(within);
  }
  const listId = useId();
  const note = items.find((i) => i.note)?.note;
  return (
    <div>
      <button
        type="button"
        title={label}
        aria-expanded={collapsed ? undefined : open}
        aria-controls={open && !collapsed ? listId : undefined}
        onClick={() => (collapsed ? router.push(to) : setOpen(!open))}
        className={itemClass(within && (collapsed || !open))}
      >
        <IconComp className="size-4 flex-none" />
        <span className="sb-hide flex-1">{label}</span>
        {note && !open ? (
          <span className="sb-hide size-1.5 rounded-full bg-[var(--amber)]" aria-label={note} />
        ) : null}
        <Icons.chevR
          className={cn(
            'sb-hide size-4 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <div
          id={listId}
          className="sb-hide ml-[15px] mt-0.5 flex flex-col gap-0.5 border-l border-sidebar-border px-2.5 py-0.5"
        >
          {items.map((it) => (
            <SideItem
              key={it.to}
              sub
              active={onRoute(pathname, it.to, it.exact)}
              to={it.to}
              label={it.label}
              note={it.note}
            />
          ))}
        </div>
      ) : null}
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : name.slice(0, 2);
  return s.toUpperCase() || '?';
}

function UserAvatar({ name, size }: { name: string; size: number }) {
  return (
    <span
      className="grid flex-none place-items-center rounded-full bg-primary font-mono font-semibold text-primary-foreground"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

function HubHeader() {
  const { state } = useStore();
  const mode = state.authMode === 'password' ? 'remote hub' : 'local hub';
  return (
    <Link
      href="/"
      title="AgentBox hub"
      className="sb-center flex h-12 w-full items-center gap-2 rounded-md px-2 transition-colors hover:bg-sidebar-hover"
    >
      <img src="/logo.svg" alt="" width={32} height={32} className="size-8 flex-none" />
      <span className="sb-hide grid min-w-0 flex-1 leading-tight">
        <span className="truncate font-mono text-sm font-semibold">
          agentbox <span className="font-normal text-muted-foreground/70">/ hub</span>
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{mode}</span>
      </span>
    </Link>
  );
}

const THEMES = [
  { id: 'light', label: 'Light', icon: Icons.sun },
  { id: 'dark', label: 'Dark', icon: Icons.moon },
  { id: 'system', label: 'System', icon: Icons.layout },
] as const;

function NavUser() {
  const router = useRouter();
  const { state } = useStore();
  const { theme, setTheme } = useTheme();
  const { name, login } = state.user;
  return (
    <Popover
      align="start"
      side="top"
      className="w-60"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          title={name}
          className="sb-center flex h-12 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left transition-colors hover:bg-sidebar-hover"
        >
          <UserAvatar name={name} size={32} />
          <span className="sb-hide grid min-w-0 flex-1 leading-tight">
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">@{login}</span>
          </span>
          <Icons.chevUD className="sb-hide size-4 text-muted-foreground" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <UserAvatar name={name} size={32} />
            <div className="grid leading-tight">
              <span className="text-sm font-medium">{name}</span>
              <span className="text-xs text-muted-foreground">@{login}</span>
            </div>
          </div>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          {THEMES.map((t) => (
            <MenuItem
              key={t.id}
              icon={t.icon}
              checked={(theme ?? 'system') === t.id}
              onClick={() => {
                setTheme(t.id);
                close();
              }}
            >
              {t.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={Icons.book} href="https://agent-box.sh/docs" external onClick={close}>
            Docs
          </MenuItem>
          {state.authMode === 'password' ? (
            <>
              <MenuSeparator />
              <MenuItem
                icon={Icons.logout}
                onClick={() => {
                  close();
                  void signOut().then(() => {
                    router.push('/signin');
                    router.refresh();
                  });
                }}
              >
                Sign out
              </MenuItem>
            </>
          ) : null}
        </div>
      )}
    </Popover>
  );
}

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
    <aside className="shad-side sticky top-[var(--banner-h,0px)] z-50 flex h-[calc(100vh-var(--banner-h,0px))] flex-col self-start overflow-hidden bg-sidebar text-sidebar-foreground">
      <div className="p-2">
        <HubHeader />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <SideGroup label="Platform">
          <SideItem
            active={dashActive}
            to="/"
            icon={Icons.grid}
            label="Boxes"
            count={state.boxes.length}
          />
          <SideItem
            active={onRoute(pathname, '/approvals')}
            to="/approvals"
            icon={Icons.shield}
            label="Approvals"
            note={state.approvals.length > 0 ? String(state.approvals.length) : undefined}
          />
          <SideItem
            active={onRoute(pathname, '/usage')}
            to="/usage"
            icon={Icons.activity}
            label="Usage"
          />
        </SideGroup>

        {/* Multi-user slot: the Team group (Members, Triggers, Team settings) and
            the "My profile" group go here once the hub has users and teams
            (docs/hub-redesign-plan.md, Phase 2). Until then Settings is one group. */}
        <SideGroup label="You">
          <NavGroup to="/settings" icon={Icons.settings} label="Settings" items={settingsItems} />
        </SideGroup>

        <SideGroup
          label="Projects"
          action={
            <AddProjectButton
              trigger={(open) => (
                <button
                  type="button"
                  aria-label="New project"
                  title="New project"
                  onClick={open}
                  className="grid size-5 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
                >
                  <Icons.plus className="size-3.5" />
                </button>
              )}
            />
          }
        >
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
        </SideGroup>
      </div>

      <div className="p-2">
        <div className="mb-1 flex flex-col gap-0.5">
          <SideItem href="https://agent-box.sh/docs" icon={Icons.book} label="Documentation" />
          <SideItem href="/api/v1/docs" icon={Icons.terminal} label="API reference" />
        </div>
        <NavUser />
      </div>
    </aside>
  );
}
