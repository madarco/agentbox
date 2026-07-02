'use client';

import Link from 'next/link';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useStore } from '@/lib/boxes/store';
import { BoxTable } from './boxes/components/box-table';
import { EmptyBox } from './boxes/components/empty-box';
import { SectionLabel } from './boxes/components/section-label';

const CREATE_SOON = 'Creating boxes from the hub is coming soon — use `agentbox create` for now.';

export default function DashboardPage() {
  const { state, boxesFor } = useStore();
  const grouped = state.projects.map((p) => ({ p, boxes: boxesFor(p.id) }));
  const totalRunning = state.boxes.filter((b) => b.status === 'running').length;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Boxes</h1>
          <div className="mt-1.5 text-sm text-muted-foreground">
            <span className="font-mono text-secondary-foreground">{totalRunning}</span> running across{' '}
            <span className="font-mono text-secondary-foreground">{state.projects.length}</span>{' '}
            project{state.projects.length === 1 ? '' : 's'} on this machine.
          </div>
        </div>
        <div className="ml-auto flex flex-none gap-2">
          <Button disabled title={CREATE_SOON}>
            <Icons.plus />
            New project
          </Button>
        </div>
      </div>

      <SectionLabel>Projects</SectionLabel>
      {grouped.length === 0 ? (
        <EmptyBox>
          <div>No boxes on this machine yet.</div>
          <div className="mt-1.5 font-mono text-xs text-muted-foreground">Create one with `agentbox create`.</div>
        </EmptyBox>
      ) : null}
      {grouped.map(({ p, boxes }) => (
        <div className="mb-7" key={p.id}>
          <div className="flex items-center gap-3 px-1 pb-3">
            <Link
              className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-[15px] font-semibold tracking-[-0.01em] text-foreground hover:text-[var(--green-ink)]"
              href={'/projects/' + p.id}
            >
              <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-md border border-[var(--green-line)] bg-accent text-primary">
                <Icons.folder className="size-[13px]" />
              </span>
              {p.name}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">{p.repo}</span>
            <span className="flex-1" />
            <span className="font-mono text-[11.5px] text-[#a4a9b0]">
              {boxes.length} box{boxes.length === 1 ? '' : 'es'}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="font-mono text-xs"
              disabled
              title={CREATE_SOON}
            >
              <Icons.plus />
              Create box
            </Button>
          </div>
          {boxes.length ? (
            <BoxTable boxes={boxes} />
          ) : (
            <EmptyBox>
              <div>
                No boxes in <b className="font-semibold text-secondary-foreground">{p.name}</b> yet.
              </div>
            </EmptyBox>
          )}
        </div>
      ))}
    </div>
  );
}
