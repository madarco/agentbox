'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { answerApprovalAction } from '@/lib/boxes/actions';

// Approve / Deny for one pending host-action approval. Answering resolves the
// parked in-box RPC on the relay; the SSE `change` refresh then drops the row.
export function ApprovalActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const answer = (a: 'y' | 'n') => {
    startTransition(async () => {
      const res = await answerApprovalAction(id, a);
      if (!res.ok) window.alert(`Failed: ${res.error}`);
      router.refresh();
    });
  };

  return (
    <div className="flex justify-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        className="hover:border-[var(--red-line)] hover:bg-[var(--red-soft)] hover:text-[var(--red)]"
        onClick={() => answer('n')}
      >
        <Icons.x />
        Deny
      </Button>
      <Button size="sm" disabled={pending} onClick={() => answer('y')}>
        <Icons.check />
        Approve
      </Button>
    </div>
  );
}
