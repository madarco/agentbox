'use client';

// The agent's live status (docs/agent-live-status-plan.md, Phase 4): the
// session title, the working-on line and the token figure. Every field is
// optional on the wire and absent means "no data", so each piece renders
// nothing rather than a placeholder or a zero.

import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentLiveUsage, AgentStatusWire, Box } from '@/lib/boxes/types';
import {
  boxRunning,
  contextFillPct,
  formatCostUsd,
  formatTokenCount,
  liveActivity,
  primaryLive,
  usageBreakdown,
  usageTotal,
} from '@/lib/live-status-view';
import { cn } from '@/lib/utils';

/** Title + working-on line under a box row's task. */
export function AgentLiveLine({ box }: { box: Box }) {
  const live = primaryLive(box);
  if (!live) return null;
  const title = distinctTitle(live.entry.sessionTitle, box.task);
  // A paused or stopped box keeps its last snapshot, whose state can still say
  // `working`; it is doing nothing now.
  const activity = boxRunning(box) ? liveActivity(live.entry) : undefined;
  if (!title && !activity) return null;
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
      {title ? <span className="max-w-[50%] flex-none truncate">{title}</span> : null}
      {title && activity ? <span className="flex-none text-[var(--faint)]">·</span> : null}
      {activity ? <WorkingOn text={activity} /> : null}
    </div>
  );
}

function WorkingOn({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span className="size-1.5 flex-none animate-pulse rounded-full bg-[var(--blue)]" />
      <span className="truncate font-mono text-[11.5px] text-secondary-foreground" title={text}>
        {text}
      </span>
    </span>
  );
}

/** The compact token figure with context fill; the full breakdown on hover. */
export function UsageFigure({ usage, className }: { usage?: AgentLiveUsage; className?: string }) {
  const total = usageTotal(usage);
  const fill = contextFillPct(usage);
  // Either figure alone is worth showing: a fresh session can know its context
  // fill before any token is counted.
  if (!usage || (total === undefined && fill === undefined)) return null;
  const cost = formatCostUsd(usage);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex cursor-default items-center gap-1.5 font-mono text-[11px] text-[var(--faint)]',
            className,
          )}
        >
          {total !== undefined ? <span>{formatTokenCount(total)} tok</span> : null}
          {fill !== undefined ? <ContextBar pct={fill} /> : null}
          {cost ? <span>{cost}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-none">
        <table className="font-mono text-[11px]">
          <tbody>
            {usageBreakdown(usage).map(([k, v]) => (
              <tr key={k}>
                <td className="pr-3 opacity-70">{k}</td>
                <td className="text-right">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TooltipContent>
    </Tooltip>
  );
}

function ContextBar({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={`context ${String(pct)}% full`}>
      <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-border">
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            pct >= 90 ? 'bg-[var(--red)]' : pct >= 70 ? 'bg-[var(--amber)]' : 'bg-[var(--faint)]',
          )}
          style={{ width: `${String(pct)}%` }}
        />
      </span>
      <span>{pct}%</span>
    </span>
  );
}

/**
 * The session title, unless it is the box's task: `task` falls back to a
 * session title, so printing both would repeat one line.
 */
function distinctTitle(title: string | undefined, task: string): string | undefined {
  return title && title.trim() !== task.trim() ? title : undefined;
}

/** Usage figure for a box row's status cell (the primary agent's). */
export function BoxUsageFigure({ box }: { box: Box }) {
  const live = primaryLive(box);
  return <UsageFigure usage={live?.entry.usage} />;
}

/** One agent's live rows for the box detail page; empty when it has nothing. */
export function agentLiveRows(
  entry: AgentStatusWire,
  running: boolean,
  task: string,
): Array<{ k: string; v: ReactNode; mono?: boolean }> {
  const rows: Array<{ k: string; v: ReactNode; mono?: boolean }> = [];
  const title = distinctTitle(entry.sessionTitle, task);
  if (title) rows.push({ k: 'Session', v: title });
  const activity = running ? liveActivity(entry) : undefined;
  if (activity) rows.push({ k: 'Working on', v: <WorkingOn text={activity} /> });
  if (usageTotal(entry.usage) !== undefined || contextFillPct(entry.usage) !== undefined) {
    rows.push({
      k: 'Tokens',
      v: <UsageFigure usage={entry.usage} className="text-[12px] text-secondary-foreground" />,
    });
  }
  return rows;
}
