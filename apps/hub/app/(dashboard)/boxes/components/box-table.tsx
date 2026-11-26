'use client';

import { useRouter } from 'next/navigation';
import { Ago } from '@/components/ago';
import { AGENTS, Icons, agentIcon } from '@/components/icons';
import { PersistentMark } from '@/components/persistent-mark';
import { StatusBadge } from '@/components/status-badge';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useStore } from '@/lib/boxes/store';
import type { Box } from '@/lib/boxes/types';
import { contextFillPct, primaryLive, usageTotal } from '@/lib/live-status-view';
import { AgentLiveLine, UsageFigure } from './agent-live';
import { BoxActions } from './box-actions';

export function AgentLabel({ agent, account }: { agent: string; account?: string }) {
  const Glyph = agentIcon(agent, Icons.terminal);
  const label = AGENTS.find((a) => a.id === agent)?.label ?? agent;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]">
      <Glyph className="size-4 flex-none" />
      {label}
      {/* The named LLM account the agent runs on, when not the default. */}
      {account && account !== 'default' ? (
        <span className="font-mono text-[11px] text-muted-foreground">@{account}</span>
      ) : null}
    </span>
  );
}

/**
 * The box list: one row per box, click to open. `showProject` adds the
 * Project column (the Dashboard's flat view); `bare` drops the card so a
 * caller can add its own footer.
 */
export function BoxTable({
  boxes,
  showProject,
  bare,
}: {
  boxes: Box[];
  showProject?: boolean;
  bare?: boolean;
}) {
  const router = useRouter();
  const { project } = useStore();
  const body = (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Task</TableHead>
          {showProject ? <TableHead className="max-lg:hidden">Project</TableHead> : null}
          <TableHead>Status</TableHead>
          <TableHead className="max-md:hidden">Agent</TableHead>
          <TableHead className="max-xl:hidden">Branch</TableHead>
          <TableHead className="text-right max-md:hidden">Tokens</TableHead>
          <TableHead className="text-right max-sm:hidden">Activity</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {boxes.map((box) => {
          const p = project(box.projectId);
          const usage = primaryLive(box)?.entry.usage;
          const hasUsage = usageTotal(usage) !== undefined || contextFillPct(usage) !== undefined;
          return (
            <TableRow
              key={box.id}
              className="cursor-pointer"
              onClick={() => router.push('/boxes/' + box.id)}
            >
              {/* max-w-0 keeps a long live line from widening the column (auto
                  table layout sizes a cell by its content); it truncates instead. */}
              <TableCell className="w-[38%] max-w-0">
                <div className="flex min-w-0 items-center gap-1.5 font-medium">
                  <span className="truncate">{box.task}</span>
                  {box.persistent ? <PersistentMark /> : null}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  <span className="font-mono">{box.name || box.id}</span> · {box.host}
                </div>
                <AgentLiveLine box={box} />
              </TableCell>
              {showProject ? (
                <TableCell className="max-lg:hidden">
                  <span className="inline-flex max-w-[160px] items-center gap-1.5 text-[13px]">
                    <Icons.folder className="size-3.5 flex-none text-muted-foreground" />
                    <span className="truncate">{p ? p.name : '—'}</span>
                  </span>
                </TableCell>
              ) : null}
              <TableCell>
                <StatusBadge status={box.status} />
              </TableCell>
              <TableCell className="max-md:hidden">
                <AgentLabel agent={box.agent} account={box.accounts?.[box.agent]} />
              </TableCell>
              <TableCell className="max-xl:hidden">
                {box.hasGit === false || !box.branch ? (
                  <span className="text-xs text-muted-foreground/60">—</span>
                ) : (
                  <span className="inline-flex max-w-[200px] items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <Icons.branch className="size-3.5 flex-none" />
                    <span className="truncate">{box.branch}</span>
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right max-md:hidden">
                {/* the context fill and, on hover, the token breakdown */}
                <UsageFigure
                  usage={usage}
                  className="justify-end text-[12.5px] text-foreground tabular-nums"
                />
                {hasUsage ? null : <span className="text-[13px] text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right text-[13px] text-muted-foreground max-sm:hidden">
                <Ago ms={box.lastActivity} />
              </TableCell>
              <TableCell className="pr-3" onClick={(e) => e.stopPropagation()}>
                <BoxActions box={box} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
  return bare ? body : <Card className="overflow-hidden">{body}</Card>;
}
