'use client';

import { useParams } from 'next/navigation';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useStore } from '@/lib/boxes/store';
import { BackLink } from '../../boxes/components/back-link';
import { BoxTable } from '../../boxes/components/box-table';
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';
import { Stat, StatGrid } from '../../boxes/components/stat-grid';

const CREATE_SOON = 'Creating boxes from the hub is coming soon — use `agentbox create` for now.';

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { project, boxesFor } = useStore();
  const proj = project(id);

  if (!proj) {
    return (
      <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8">
        <BackLink to="/">Dashboard</BackLink>
        <EmptyBox>Project not found.</EmptyBox>
      </div>
    );
  }

  const boxes = boxesFor(id);
  const running = boxes.filter((b) => b.status === 'running').length;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <BackLink to="/">All projects</BackLink>

      <div className="flex items-start gap-4 max-md:flex-col">
        <div className="min-w-0">
          <h1 className="flex items-center gap-3 text-[25px] font-semibold leading-tight tracking-[-0.025em]">
            <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-md border border-[var(--green-line)] bg-accent text-primary">
              <Icons.folder className="size-[15px]" />
            </span>
            {proj.name}
          </h1>
          <div className="mt-1.5 text-sm text-muted-foreground">
            <span className="font-mono text-secondary-foreground">{proj.repo}</span> · {proj.provider}
          </div>
        </div>
        <div className="ml-auto flex flex-none gap-2 max-md:ml-0">
          <Button disabled title={CREATE_SOON}>
            <Icons.plus />
            Create box
          </Button>
        </div>
      </div>

      <div className="mt-5">
        <StatGrid>
          <Stat k="Boxes" v={boxes.length} icon={Icons.box} />
          <Stat k="Running" v={running} icon={Icons.activity} />
          <Stat k="Provider" v={proj.provider} mono />
          <Stat k="Created" v={<Ago ms={proj.createdAt} />} mono />
        </StatGrid>
      </div>

      <SectionLabel>Boxes</SectionLabel>
      {boxes.length ? (
        <BoxTable boxes={boxes} />
      ) : (
        <EmptyBox>
          <div>No boxes yet.</div>
        </EmptyBox>
      )}
    </div>
  );
}
