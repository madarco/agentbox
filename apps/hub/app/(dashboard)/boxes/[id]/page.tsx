'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Ago } from '@/components/ago';
import { agentIcon, Icons, type Icon } from '@/components/icons';
import { PersistentMark } from '@/components/persistent-mark';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useStore } from '@/lib/boxes/store';
import type { Box } from '@/lib/boxes/types';
import { boxRunning, formatTokenCount, primaryLive, usageTotal } from '@/lib/live-status-view';
import { BoxApprovals } from '../../approvals/components/box-approvals';
import { AccountRows } from '../components/account-switcher';
import { Access } from '../components/access';
import { agentLiveRows } from '../components/agent-live';
import { BotPanel } from '../components/bot-panel';
import { BoxActions } from '../components/box-actions';
import { AgentLabel } from '../components/box-table';
import { DRow } from '../components/d-row';
import { EmptyBox } from '../components/empty-box';
import { GitActions } from '../components/git-actions';
import { SectionLabel } from '../components/section-label';
import { ServicesPanel } from '../components/services-panel';
import { SkillsPanel } from '../components/skills-panel';

export default function BoxDetailPage() {
  // The segment comes back still percent-encoded, so a failed create's
  // synthetic `job:<id>` row would never match.
  const id = decodeURIComponent(useParams<{ id: string }>().id);
  const { box: getBox, project } = useStore();
  const box = getBox(id);

  if (!box) {
    return (
      <div className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-6 max-sm:px-4">
        <EmptyBox>
          <div className="font-medium text-foreground">This box no longer exists</div>
          <div className="mt-1">It may have been destroyed.</div>
          <Button variant="outline" className="mt-4" href="/">
            Back to boxes
          </Button>
        </EmptyBox>
      </div>
    );
  }

  const proj = project(box.projectId);
  const Glyph = agentIcon(box.agent, Icons.terminal);
  const tokens = usageTotal(primaryLive(box)?.entry.usage);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-6 max-sm:px-4">
      <div className="flex items-start gap-4 max-lg:flex-col">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="grid size-11 flex-none place-items-center rounded-xl border border-border bg-card shadow-sm">
            <Glyph className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
              {box.task}
              {box.persistent ? <PersistentMark className="size-4" /> : null}
              <StatusBadge status={box.status} />
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="font-mono text-[13px]">{box.name || box.id}</span>
              {proj ? (
                <Link
                  href={'/projects/' + proj.id}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <Icons.folder className="size-3.5" />
                  {proj.name}
                </Link>
              ) : null}
              {box.hasGit === false || !box.branch ? null : (
                <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[13px]">
                  <Icons.branch className="size-3.5 flex-none" />
                  <span className="truncate">{box.branch}</span>
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Icons.server className="size-3.5" />
                {box.host}
              </span>
            </div>
          </div>
        </div>
        <div className="ml-auto flex-none max-lg:ml-0">
          <BoxActions box={box} size="lg" />
        </div>
      </div>

      {box.error ? (
        <Alert
          className="mt-5 border-[var(--red-line)] bg-[var(--red-soft)] text-[var(--red)]"
          icon={Icons.warn}
          title="Box errored"
        >
          <span className="font-mono text-foreground/80 [overflow-wrap:anywhere]">{box.error}</span>
        </Alert>
      ) : null}

      <BoxApprovals boxId={box.id} />

      <div className="mt-6 grid grid-cols-3 gap-6 max-lg:grid-cols-1">
        <div className="col-span-2 min-w-0 max-lg:col-span-1">
          <div className="grid grid-cols-4 gap-3 max-sm:grid-cols-2">
            <MiniStat k="Commits" v={box.commits ?? '—'} icon={Icons.commit} />
            <MiniStat k="Files touched" v={box.filesTouched ?? '—'} icon={Icons.file} />
            <MiniStat
              k="Tokens"
              v={tokens === undefined ? '—' : formatTokenCount(tokens)}
              icon={Icons.zap}
            />
            <MiniStat k="Last activity" v={<Ago ms={box.lastActivity} />} icon={Icons.clock} />
          </div>

          <AgentSessions box={box} />

          {/* Access owns its "Access" heading and self-hides when the box has no
              web/VNC endpoint and no launchable host app. */}
          <Access box={box} />

          {/* Backup + clone. Self-hides for a synthetic create-job row; the Backup
              row itself only appears when the box's agent has an identity to keep. */}
          <BotPanel box={box} />

          {/* A box created from a plain directory has no worktree and no remote, so
              every button in this card would fail. `undefined` means the source did
              not say (hosted plane, older hub) — show it, as before. */}
          {box.hasGit === false ? null : (
            <>
              <SectionLabel>Git</SectionLabel>
              <GitActions box={box} />
            </>
          )}

          <ServicesPanel id={box.id} running={box.status === 'running'} />

          <SkillsPanel id={box.id} running={box.status === 'running'} />
        </div>

        <div className="min-w-0">
          <Card className="overflow-hidden">
            <div className="px-5 pb-3 pt-5 text-sm font-semibold">Details</div>
            <div className="divide-y divide-border border-t border-border">
              <DRow k="Box ID" v={box.id} mono />
              <DRow
                k="Project"
                v={proj ? proj.name : '—'}
                link={proj ? '/projects/' + box.projectId : null}
              />
              <DRow k="Repository" v={box.repo} mono />
              {/* A cloud box is minted an `agentbox/<name>` branch name whether or not
                  its workspace is a repo, so on a repo-less box this row named a branch
                  that does not exist anywhere. */}
              {box.hasGit === false ? null : <DRow k="Branch" v={box.branch} mono />}
              <DRow k="Agent" v={<AgentLabel agent={box.agent} />} />
              <DRow k="Host" v={box.host} mono />
              {box.status === 'creating' || box.status === 'error' ? null : <AccountRows box={box} />}
              <DRow k="Created" v={new Date(box.createdAt).toLocaleString()} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ k, v, icon: IconComp }: { k: string; v: ReactNode; icon: Icon }) {
  return (
    <Card className="min-w-0 p-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <IconComp className="size-3.5" />
        {k}
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums">{v}</div>
    </Card>
  );
}

/**
 * Each reporting agent's session title, working-on line and tokens. Hidden when
 * no agent has any of them (an older hub, or a box whose agent has not run).
 */
function AgentSessions({ box }: { box: Box }) {
  const running = boxRunning(box);
  const agents = Object.entries(box.agentStatus ?? {})
    .map(([agent, entry]) => ({
      agent,
      entry,
      rows: agentLiveRows(entry, running, box.task),
    }))
    .filter((a) => a.rows.length > 0)
    .sort((a, b) => Number(b.agent === box.agent) - Number(a.agent === box.agent));
  if (agents.length === 0) return null;
  const many = agents.length > 1;
  return (
    <>
      <SectionLabel>Agent session</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {agents.flatMap(({ agent, entry, rows }) =>
          [
            // The agent's state only while the box runs: a paused or stopped
            // box keeps its last snapshot, which can still say `working`.
            ...(many
              ? [
                  {
                    k: 'Agent',
                    v: running && entry.state ? `${agent} · ${entry.state}` : agent,
                    mono: true,
                  },
                ]
              : []),
            ...rows,
          ].map((r) => <DRow key={`${agent}-${r.k}`} k={r.k} v={r.v} mono={r.mono} />),
        )}
      </Card>
    </>
  );
}
