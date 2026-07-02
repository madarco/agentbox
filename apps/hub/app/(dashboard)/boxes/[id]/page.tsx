'use client';

import { useParams } from 'next/navigation';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { useStore } from '@/lib/boxes/store';
import { AgentTerminal } from '../components/agent-terminal';
import { BackLink } from '../components/back-link';
import { BoxActions } from '../components/box-actions';
import { DRow } from '../components/d-row';
import { EmptyBox } from '../components/empty-box';
import { SectionLabel } from '../components/section-label';
import { Stat, StatGrid } from '../components/stat-grid';

export default function BoxDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { box: getBox, project } = useStore();
  const box = getBox(id);

  if (!box) {
    return (
      <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8">
        <BackLink to="/">All boxes</BackLink>
        <EmptyBox>This box no longer exists — it may have been destroyed.</EmptyBox>
      </div>
    );
  }

  const proj = project(box.projectId);

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <BackLink to={'/projects/' + box.projectId}>{proj ? proj.name : 'Project'}</BackLink>

      <div className="flex items-start gap-4 max-md:flex-col">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-3 text-[25px] font-semibold leading-tight tracking-[-0.025em]">
            {box.task}
            <StatusBadge status={box.status} />
          </h1>
          <div className="mt-1.5 text-sm text-muted-foreground">
            <span className="font-mono text-secondary-foreground">{box.id}</span> ·{' '}
            <span className="font-mono text-secondary-foreground">{box.repo}</span> · {box.host}
          </div>
        </div>
        <div className="ml-auto flex-none max-md:ml-0">
          <BoxActions box={box} size="lg" />
        </div>
      </div>

      {box.error ? (
        <Alert className="mt-4 border-[var(--red-line)] bg-[var(--red-soft)] text-[var(--red)]" icon={Icons.warn} title="Box errored">
          <span className="font-mono text-secondary-foreground">{box.error}</span>
        </Alert>
      ) : null}

      <SectionLabel>Overview</SectionLabel>
      <StatGrid>
        <Stat k="Status" v={<StatusBadge status={box.status} />} />
        <Stat k="Agent CLI" v={box.agent} mono />
        <Stat k="Commits" v={box.commits ?? '—'} icon={Icons.commit} />
        <Stat k="Files touched" v={box.filesTouched ?? '—'} icon={Icons.file} />
        <Stat k="Last activity" v={<Ago ms={box.lastActivity} />} mono />
      </StatGrid>

      <SectionLabel>Agent output</SectionLabel>
      <AgentTerminal box={box} />

      <SectionLabel>Details</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        <DRow k="Box ID" v={box.id} mono />
        <DRow k="Project" v={proj ? proj.name : '—'} link={proj ? '/projects/' + box.projectId : null} />
        <DRow k="Repository" v={box.repo} mono />
        <DRow k="Branch" v={box.branch} mono />
        <DRow k="Host" v={box.host} mono />
        <DRow k="Created" v={new Date(box.createdAt).toLocaleString()} mono />
      </Card>
    </div>
  );
}
