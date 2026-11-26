'use client';

// ⌘K: jump to a box, project or page, or run a shell action. Searches only
// what the hub store already holds (no request of its own).

import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icons, type Icon } from '@/components/icons';
import { toggleSidebar } from '@/components/shell-state';
import { StatusBadge } from '@/components/status-badge';
import { Kbd } from '@/components/ui/kbd';
import { useStore } from '@/lib/boxes/store';
import type { BoxStatus } from '@/lib/boxes/types';
import { cn } from '@/lib/utils';

interface Item {
  label: string;
  icon: Icon;
  run: () => void;
  hint?: string;
  /** Extra words the filter matches. */
  kw?: string;
  status?: BoxStatus;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { state } = useStore();
  const { resolvedTheme, setTheme } = useTheme();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const go = (to: string) => () => router.push(to);
    const boxes: Item[] = state.boxes.map((b) => ({
      label: b.task,
      icon: Icons.box,
      run: go('/boxes/' + b.id),
      hint: b.name || b.id,
      kw: `${b.id} ${b.branch}`,
      status: b.status,
    }));
    const actions: Item[] = [
      {
        label: 'Toggle theme',
        icon: resolvedTheme === 'dark' ? Icons.sun : Icons.moon,
        run: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
        kw: 'dark light mode',
      },
      { label: 'Toggle sidebar', icon: Icons.panel, run: toggleSidebar, hint: '⌘B' },
    ];
    const pages: Item[] = [
      { label: 'Boxes', icon: Icons.grid, run: go('/'), kw: 'dashboard home' },
      {
        label: 'Approvals',
        icon: Icons.shield,
        run: go('/approvals'),
        hint: state.approvals.length ? `${String(state.approvals.length)} pending` : undefined,
      },
      { label: 'Usage', icon: Icons.activity, run: go('/usage') },
      { label: 'Settings', icon: Icons.settings, run: go('/settings') },
      {
        label: 'Subscriptions',
        icon: Icons.gauge,
        run: go('/settings/subscriptions'),
        kw: 'settings limits accounts',
      },
      { label: 'Skills', icon: Icons.book, run: go('/settings/skills'), kw: 'settings' },
      { label: 'Files', icon: Icons.file, run: go('/settings/files'), kw: 'settings custody' },
      { label: 'Devices', icon: Icons.host, run: go('/settings/devices'), kw: 'settings pc' },
      {
        label: 'System',
        icon: Icons.server,
        run: go('/settings/system'),
        kw: 'settings providers prepare bake',
      },
    ];
    const projects: Item[] = state.projects.map((p) => ({
      label: p.name,
      icon: Icons.folder,
      run: go('/projects/' + p.id),
      hint: p.repo,
    }));
    const needle = q.trim().toLowerCase();
    const match = (it: Item) =>
      !needle || `${it.label} ${it.kw ?? ''} ${it.hint ?? ''}`.toLowerCase().includes(needle);
    return [
      { heading: 'Boxes', items: boxes.filter(match) },
      { heading: 'Actions', items: actions.filter(match) },
      { heading: 'Go to', items: pages.filter(match) },
      { heading: 'Projects', items: projects.filter(match) },
    ].filter((g) => g.items.length > 0);
  }, [q, state, router, resolvedTheme, setTheme]);

  const flat = groups.flatMap((g) => g.items);
  const cur = Math.min(sel, Math.max(0, flat.length - 1));

  useEffect(() => {
    listRef.current?.querySelector("[data-sel='true']")?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const pick = (it: Item) => {
    onClose();
    it.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(flat.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && flat[cur]) {
      e.preventDefault();
      pick(flat[cur]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  let idx = -1;
  return (
    <div className="anim-fade fixed inset-0 z-[60] bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="anim-pop mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-[560px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5">
          <Icons.search className="size-4 flex-none opacity-50" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            placeholder="Search boxes, projects, pages…"
            className="h-12 w-full border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Kbd>esc</Kbd>
        </div>
        <div
          id="cmdk-list"
          ref={listRef}
          role="listbox"
          className="max-h-[360px] overflow-y-auto p-1.5"
        >
          {flat.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No results found.</div>
          ) : null}
          {groups.map((g) => (
            <div key={g.heading} className="mb-1">
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                {g.heading}
              </div>
              {g.items.map((it) => {
                idx += 1;
                const i = idx;
                const on = i === cur;
                return (
                  <button
                    key={`${g.heading}-${String(i)}`}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-sel={on ? 'true' : 'false'}
                    onMouseMove={() => setSel(i)}
                    onClick={() => pick(it)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 px-2 py-2 text-left text-sm',
                      on ? 'bg-accent text-accent-foreground' : 'bg-transparent',
                    )}
                  >
                    <it.icon className="size-4 flex-none text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.status ? <StatusBadge status={it.status} /> : null}
                    {it.hint ? (
                      <span className="max-w-[40%] flex-none truncate font-mono text-xs text-muted-foreground">
                        {it.hint}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>navigate
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd>open
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <Kbd>⌘K</Kbd>toggle
          </span>
        </div>
      </div>
    </div>
  );
}
