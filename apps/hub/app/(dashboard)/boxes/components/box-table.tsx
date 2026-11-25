'use client';

import { useRouter } from 'next/navigation';
import { Ago } from '@/components/ago';
import { agentIcon, Icons } from '@/components/icons';
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
import type { Box } from '@/lib/boxes/types';
import { AgentLiveLine, BoxUsageFigure } from './agent-live';
import { BoxActions } from './box-actions';

export function BoxTable({ boxes }: { boxes: Box[] }) {
  const router = useRouter();
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[38%]">Task</TableHead>
            <TableHead className="w-[27%] max-md:hidden">Branch</TableHead>
            <TableHead className="max-md:hidden">Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {boxes.map((box) => (
            <TableRow
              key={box.id}
              className="cursor-pointer"
              onClick={() => router.push('/boxes/' + box.id)}
            >
              <TableCell>
                <div className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium">
                  <span className="truncate">{box.task}</span>
                  {box.persistent ? <PersistentMark /> : null}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-[#a4a9b0]">
                  {box.name || box.id} · {box.host}
                </div>
                <AgentLiveLine box={box} />
              </TableCell>
              <TableCell className="max-md:hidden">
                <span className="inline-flex max-w-full items-center gap-1.5 font-mono text-xs text-secondary-foreground">
                  <Icons.branch className="size-3 flex-none text-muted-foreground" />
                  <span className="truncate">{box.branch}</span>
                </span>
                <div className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-[#a4a9b0]">
                  <AgentGlyph agent={box.agent} />
                  {box.agent}
                  {/* The named LLM account the agent runs on, when not the default. */}
                  {box.accounts?.[box.agent] && box.accounts[box.agent] !== 'default'
                    ? `@${box.accounts[box.agent]}`
                    : ''}{' '}
                  · <Ago ms={box.lastActivity} />
                </div>
              </TableCell>
              <TableCell className="max-md:hidden">
                <StatusBadge status={box.status} />
                <div className="mt-1">
                  <BoxUsageFigure box={box} />
                </div>
              </TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                <BoxActions box={box} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function AgentGlyph({ agent }: { agent: string }) {
  const Glyph = agentIcon(agent);
  return <Glyph className="size-3 flex-none" />;
}
