'use client';

import Link from 'next/link';
import { Ago } from '@/components/ago';
import { Icons } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useStore } from '@/lib/boxes/store';
import { EmptyBox } from '../boxes/components/empty-box';
import { SectionLabel } from '../boxes/components/section-label';
import { ApprovalActions } from './components/approval-actions';

export default function ApprovalsPage() {
  const { state, box: getBox } = useStore();
  const approvals = [...state.approvals].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <div className="min-w-0">
        <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Approvals</h1>
        <div className="mt-1.5 text-sm text-muted-foreground">
          Host actions a box is waiting on — <span className="font-mono text-secondary-foreground">{approvals.length}</span>{' '}
          pending. Approving unblocks the box; denying returns an error to it.
        </div>
      </div>

      <SectionLabel>Pending</SectionLabel>
      {approvals.length === 0 ? (
        <EmptyBox>
          <div>No pending approvals.</div>
          <div className="mt-1.5 font-mono text-xs text-muted-foreground">
            Host actions (git push, file copy, downloads) appear here when a box requests one.
          </div>
        </EmptyBox>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[24%]">Box</TableHead>
                <TableHead className="w-[40%]">Action</TableHead>
                <TableHead className="max-md:hidden">Requested</TableHead>
                <TableHead className="text-right">Answer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.map((a) => {
                const box = getBox(a.boxId);
                return (
                  <TableRow key={a.id} className="hover:bg-transparent">
                    <TableCell>
                      {box ? (
                        <Link className="text-[13.5px] font-medium hover:text-[var(--green-ink)]" href={'/boxes/' + box.id}>
                          {box.task}
                        </Link>
                      ) : (
                        <div className="text-[13.5px] font-medium">{a.boxId}</div>
                      )}
                      <div className="mt-0.5 font-mono text-[11px] text-[#a4a9b0]">{box ? box.repo : a.boxId}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-start gap-1.5 text-[13px]">
                        <Icons.shield className="mt-0.5 size-3.5 flex-none text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate font-mono text-secondary-foreground">{a.command ?? a.message}</div>
                          {a.detail ? <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{a.detail}</div> : null}
                          {a.cwd ? <div className="mt-0.5 truncate font-mono text-[11px] text-[#a4a9b0]">{a.cwd}</div> : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="max-md:hidden">
                      <span className="font-mono text-xs text-muted-foreground">
                        <Ago ms={a.createdAt} />
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <ApprovalActions approval={a} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
