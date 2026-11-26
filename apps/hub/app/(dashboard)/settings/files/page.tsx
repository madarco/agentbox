'use client';

// Files page (Settings → Files): what the hub holds so boxes can start without
// the PC, grouped for people (project files, agent logins, skills, bakes, box
// keys). Read-only. PURE REST CLIENT: GET /api/v1/custody returns metadata only
// (path, size, sha256, mtime), never a value; project and box names come from
// the store, account labels from GET /api/v1/accounts, machine names from GET
// /api/v1/devices. None returns contents.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { useStore } from '@/lib/boxes/store';
import { fmtBytes, type CustodyEntry } from '@/lib/custody-view';
import {
  buildFilesView,
  type FilesGroup,
  type FilesGroupId,
  type FilesRow,
} from '@/lib/files-view';
import { cn } from '@/lib/utils';
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';
import { Stat, StatGrid } from '../../boxes/components/stat-grid';

interface CustodyResponse {
  enabled: boolean;
  entries: CustodyEntry[];
}

interface AccountsResponse {
  accounts?: { agent: string; id: string; label?: string }[];
  machine?: string;
}

interface DevicesResponse {
  devices?: { id: string; label: string }[];
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`request failed (${String(r.status)})`);
  return (await r.json()) as T;
}

export default function FilesPage() {
  const { state } = useStore();
  const [data, setData] = useState<CustodyResponse | null>(null);
  const [accounts, setAccounts] = useState<AccountsResponse>({});
  const [machines, setMachines] = useState<DevicesResponse['devices']>([]);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<FilesGroupId | null>(null);

  useEffect(() => {
    let alive = true;
    getJson<CustodyResponse>('/api/v1/custody')
      .then((j) => {
        if (alive) setData(j);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    // Names only, both optional: without them a row shows ids. A local hub has
    // no device service (503).
    getJson<AccountsResponse>('/api/v1/accounts')
      .then((j) => {
        if (alive) setAccounts(j);
      })
      .catch(() => {});
    getJson<DevicesResponse>('/api/v1/devices')
      .then((j) => {
        if (alive) setMachines(j.devices ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(
    () =>
      buildFilesView(data?.entries ?? [], {
        projects: state.projects,
        boxes: state.boxes,
        accounts: accounts.accounts,
        machine: accounts.machine,
        machines,
      }),
    [data, state.projects, state.boxes, accounts, machines],
  );
  const total = groups.reduce((n, g) => n + g.count, 0);
  // Other appears only when the hub holds something this page has no group for.
  const listed = groups.filter((g) => g.id !== 'other' || g.count > 0);
  const shown = (only ? groups.filter((g) => g.id === only) : groups).filter((g) => g.count > 0);
  const selected = only ? groups.find((g) => g.id === only) : undefined;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Files</h1>
      <div className="mt-1.5 text-sm text-muted-foreground">
        The files this hub holds so a box can start without your PC. Names, sizes and dates only:{' '}
        <span className="text-secondary-foreground">contents never leave the hub</span>. Read-only;
        the CLI writes them.
      </div>
      <div className="mt-2 text-[12.5px] text-muted-foreground">
        Untracked files in your checkout are not stored here: they are copied into the box when it
        is created (with your stash), straight from the PC.
      </div>

      {error ? (
        <div className="mt-6">
          <EmptyBox>
            <div>Couldn’t load the hub’s files.</div>
            <div className="mt-1.5 font-mono text-xs text-red-400">{error}</div>
          </EmptyBox>
        </div>
      ) : data && !data.enabled ? (
        <div className="mt-6">
          <EmptyBox>
            <div>This hub holds no files.</div>
            <div className="mt-1.5 font-mono text-xs text-muted-foreground">
              Files are kept by a control box (a hub with an admin token). A localhost hub reads
              logins and project files from your machine directly — see{' '}
              <Link
                href="/settings/system"
                className="underline underline-offset-2 hover:text-foreground"
              >
                System
              </Link>
              .
            </div>
          </EmptyBox>
        </div>
      ) : !data ? (
        <div className="mt-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <SectionLabel
            right={
              <span className="font-mono text-[11px] tracking-normal text-[var(--faint)]">
                {total} files
              </span>
            }
          >
            Overview
          </SectionLabel>
          <StatGrid>
            {listed.map((g) => (
              <Stat
                key={g.id}
                k={g.label}
                v={g.count ? `${String(g.count)} · ${fmtBytes(g.size)}` : '0'}
              />
            ))}
          </StatGrid>

          <div className="mt-6 flex flex-wrap items-center gap-1.5">
            <Pill active={only === null} onClick={() => setOnly(null)} label="All" count={total} />
            {listed.map((g) => (
              <Pill
                key={g.id}
                active={only === g.id}
                onClick={() => setOnly(g.id)}
                label={g.label}
                count={g.count}
              />
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="mt-6">
              <EmptyBox>
                <div>
                  {selected ? `No ${selected.label.toLowerCase()} here.` : 'Nothing here yet.'}
                </div>
                <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                  {selected
                    ? selected.empty
                    : 'Logins arrive with `agentbox hub credentials push`, project files with `agentbox hub project push`; bake records and box keys are written as boxes are created.'}
                </div>
              </EmptyBox>
            </div>
          ) : (
            shown.map((g) => <GroupView key={g.id} group={g} />)
          )}
        </>
      )}
    </div>
  );
}

function GroupView({ group }: { group: FilesGroup }) {
  return (
    <section aria-label={group.label}>
      <SectionLabel
        right={
          group.link ? (
            <Link
              href={group.link.href}
              className="text-[12px] normal-case tracking-normal text-primary underline-offset-2 hover:underline"
            >
              {group.link.label}
            </Link>
          ) : (
            <span className="font-mono text-[11px] tracking-normal text-[var(--faint)]">
              {fmtBytes(group.size)}
            </span>
          )
        }
      >
        {group.label}
      </SectionLabel>
      <div className="mb-3 text-[12.5px] text-muted-foreground">{group.blurb}</div>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {group.sections.map((s) => (
          <div key={s.key} className="p-4 px-5">
            {group.sections.length > 1 || group.id === 'projects' || group.id === 'agents' ? (
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <Icons.folder className="size-[15px] flex-none text-muted-foreground" />
                {s.href ? (
                  <Link
                    href={s.href}
                    className="truncate text-[13.5px] font-medium hover:underline"
                  >
                    {s.title}
                  </Link>
                ) : (
                  <span className="truncate text-[13.5px] font-medium">{s.title}</span>
                )}
                {s.projects ? (
                  <span className="truncate text-[12px] text-muted-foreground">
                    {s.projects.map((p, i) => (
                      <span key={p.id}>
                        {i ? ', ' : ''}
                        <Link href={p.href} className="hover:underline">
                          {p.name}
                        </Link>
                      </span>
                    ))}
                  </span>
                ) : null}
                {s.subtitle && s.subtitle !== s.title ? (
                  <span className="truncate font-mono text-[11px] text-[var(--faint)]">
                    {s.subtitle}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="divide-y divide-border/40">
              {s.rows.map((r) => (
                <Row key={r.key} row={r} />
              ))}
            </div>
          </div>
        ))}
      </Card>
    </section>
  );
}

function Row({ row }: { row: FilesRow }) {
  const title = row.href ? (
    <Link href={row.href} className="hover:underline">
      {row.title}
    </Link>
  ) : (
    row.title
  );
  return (
    <div className="flex items-center gap-3 py-1.5 max-sm:flex-wrap">
      <Icons.file className="size-3.5 flex-none text-[var(--faint)]" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12.5px]">{title}</div>
        {row.detail || row.hint ? (
          <div className="truncate text-[11.5px] text-muted-foreground">
            {row.detail}
            {row.detail && row.hint ? ' · ' : ''}
            {row.hint ? <span className="font-mono">{row.hint}</span> : null}
          </div>
        ) : null}
      </div>
      {row.files > 1 ? (
        <span className="font-mono text-[11px] text-[var(--faint)]">{row.files} files</span>
      ) : null}
      <span className="w-16 text-right font-mono text-[11px] text-muted-foreground">
        {fmtBytes(row.size)}
      </span>
      <span className="w-24 text-right font-mono text-[11px] text-muted-foreground">
        {row.updatedAt ? <Ago ms={row.updatedAt} /> : '—'}
      </span>
    </div>
  );
}

function Pill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors',
        active
          ? 'border-transparent bg-[var(--green-soft)] font-medium text-[var(--green-ink)]'
          : 'border-border text-secondary-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {label}
      <span className={cn('font-mono text-[11px]', active ? 'text-primary' : 'text-[var(--faint)]')}>
        {count}
      </span>
    </button>
  );
}
