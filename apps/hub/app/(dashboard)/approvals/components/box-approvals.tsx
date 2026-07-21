'use client';

import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { useStore } from '@/lib/boxes/store';
import { ApprovalActions } from './approval-actions';

// Pending host-action approvals for a single box, shown on its detail page.
// Answering resolves the box's parked RPC; the SSE `change` refresh then drops
// the row (and the whole block when the box's last approval is answered).
export function BoxApprovals({ boxId }: { boxId: string }) {
  const { state } = useStore();
  const approvals = state.approvals.filter((a) => a.boxId === boxId).sort((a, b) => a.createdAt - b.createdAt);
  if (approvals.length === 0) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-[var(--amber-line)] bg-[var(--amber-soft)]">
      <div className="flex items-center gap-2 border-b border-[var(--amber-line)] px-4 py-2.5">
        <Icons.shield className="size-4 flex-none text-[var(--amber)]" />
        <span className="text-[13.5px] font-semibold">
          {approvals.length} pending approval{approvals.length === 1 ? '' : 's'}
        </span>
        <span className="text-[12.5px] text-muted-foreground">— this box is waiting on you.</span>
      </div>
      <div className="divide-y divide-[var(--amber-line)]">
        {approvals.map((a) => (
          <div key={a.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px] text-secondary-foreground">{a.command ?? a.message}</div>
              {a.detail ? <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{a.detail}</div> : null}
              {a.cwd ? <div className="mt-0.5 truncate font-mono text-[11px] text-[#a4a9b0]">{a.cwd}</div> : null}
              <div className="mt-0.5 font-mono text-[11px] text-[#a4a9b0]">
                <Ago ms={a.createdAt} />
              </div>
            </div>
            <div className="flex-none pt-0.5">
              <ApprovalActions id={a.id} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
