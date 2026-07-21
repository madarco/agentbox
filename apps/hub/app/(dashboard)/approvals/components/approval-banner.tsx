'use client';

import Link from 'next/link';
import { Icons } from '@/components/icons';
import { useStore } from '@/lib/boxes/store';
import { ApprovalActions } from './approval-actions';

// Top-of-dashboard banner surfacing the oldest pending host-action approval with
// its Deny/Approve buttons. Answering resolves the box's parked RPC; the SSE
// `change` refresh then re-reads state.approvals so the banner advances to the
// next-oldest (or self-hides when none remain) — no local queue needed.
export function ApprovalBanner() {
  const { state, box: getBox } = useStore();
  if (state.approvals.length === 0) return null;

  const approvals = [...state.approvals].sort((a, b) => a.createdAt - b.createdAt);
  const a = approvals[0];
  const box = getBox(a.boxId);

  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-[var(--amber-line)] bg-[var(--amber-soft)] p-4">
      <Icons.shield className="mt-0.5 size-4 flex-none text-[var(--amber)]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {box ? (
            <Link className="text-[13.5px] font-semibold hover:text-[var(--green-ink)]" href={'/boxes/' + box.id}>
              {box.task}
            </Link>
          ) : (
            <span className="text-[13.5px] font-semibold">{a.boxId}</span>
          )}
          <span className="truncate font-mono text-[12.5px] text-secondary-foreground">{a.command ?? a.message}</span>
        </div>
        {a.detail ? <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{a.detail}</div> : null}
        {a.cwd ? <div className="mt-0.5 truncate font-mono text-[11px] text-[#a4a9b0]">{a.cwd}</div> : null}
      </div>
      <div className="flex flex-none items-center gap-3">
        {approvals.length > 1 ? (
          <div className="hidden items-center gap-2 sm:flex">
            <span className="font-mono text-[11.5px] text-[var(--amber)]">{approvals.length} pending</span>
            <Link className="font-mono text-[11.5px] text-muted-foreground hover:text-[var(--green-ink)]" href="/approvals">
              View all
            </Link>
          </div>
        ) : null}
        <ApprovalActions id={a.id} />
      </div>
    </div>
  );
}
