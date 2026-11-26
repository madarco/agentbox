'use client';

import { useParams } from 'next/navigation';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useStore } from '@/lib/boxes/store';
import { BackLink } from '../../boxes/components/back-link';
import { BoxTable } from '../../boxes/components/box-table';
import { CreateBoxButton } from '../../boxes/components/create-box-modal';
import { DeleteProjectButton } from '../../boxes/components/delete-project-button';
import { EmptyBox } from '../../boxes/components/empty-box';
import { SectionLabel } from '../../boxes/components/section-label';
import { Stat, StatGrid } from '../../boxes/components/stat-grid';
import { ProjectBots } from './components/project-bots';
import { ProjectSeed } from './components/project-seed';

/** An https(s) origin is clickable; an scp/ssh remote is shown as plain text. */
function originHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url.replace(/\.git$/i, '') : null;
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { project, boxesFor } = useStore();
  const proj = project(id);

  if (!proj) {
    return (
      <div className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-6 max-sm:px-4">
        <BackLink to="/">All boxes</BackLink>
        <EmptyBox icon={Icons.folder}>Project not found.</EmptyBox>
      </div>
    );
  }

  const boxes = boxesFor(id);
  const running = boxes.filter((b) => b.status === 'running').length;
  const branch = proj.currentBranch || proj.defaultBranch;
  const origin = proj.originUrl?.trim() || null;
  const href = origin ? originHref(origin) : null;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-6 max-sm:px-4">
      <BackLink to="/">All boxes</BackLink>

      <div className="flex items-start gap-4 max-md:flex-col">
        <div className="min-w-0">
          <h1 className="flex items-center gap-3 text-[26px] font-semibold leading-tight tracking-[-0.025em]">
            <span className="grid size-[26px] flex-none place-items-center rounded-md border border-[var(--green-line)] bg-[var(--green-soft)] text-[var(--green-ink)]">
              <Icons.folder className="size-[15px]" />
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{proj.name}</span>
          </h1>
          <div className="mt-1.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            <span className="font-mono text-secondary-foreground">{origin ?? proj.repo}</span>
            {branch ? (
              <>
                {' '}
                · branch <span className="font-mono text-secondary-foreground">{branch}</span>
              </>
            ) : null}{' '}
            · {proj.provider}
          </div>
        </div>
        <div className="ml-auto flex flex-none flex-wrap gap-2 max-md:ml-0">
          {href ? (
            <Button variant="outline" href={href} target="_blank" rel="noopener">
              <Icons.repo />
              Repo
            </Button>
          ) : null}
          {boxes.length === 0 ? <DeleteProjectButton project={proj} redirectHome /> : null}
          <CreateBoxButton project={proj} />
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

      <ProjectSeed projectId={id} />

      {/* Restore lives on the project, not on a box: a bundle outlives the box it
          came from, so there is usually no box left to click. Self-hides when the
          project holds no bots. */}
      <ProjectBots project={proj} />

      <SectionLabel>Boxes</SectionLabel>
      {boxes.length ? (
        <BoxTable boxes={boxes} />
      ) : (
        <EmptyBox>
          <div className="font-medium text-foreground">No boxes yet</div>
          <div className="mt-1">Create one to start an agent on this project.</div>
        </EmptyBox>
      )}
    </div>
  );
}
