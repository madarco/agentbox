'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { answerApprovalAction } from '@/lib/boxes/actions';

// Approve / Deny for one pending host-action approval. Answering resolves the
// parked in-box RPC on the relay; the SSE `change` refresh then drops the row.
//
// An `open-link` approval (`url` set) is not a question: the box wants the link
// opened on the human's machine, and the relay can't do that when it lives on a
// control box. So the primary button is a real anchor — a fetch-then-
// `window.open` would lose the user-activation token across the await and be
// popup-blocked (same reason `boxes/components/access.tsx` uses one) — and the
// click also claims the approval with `openedByClient`, telling the relay this
// surface opened it so it must not open a second copy host-side.
export function ApprovalActions({ id, url }: { id: string; url?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const answer = (a: 'y' | 'n') => {
    startTransition(async () => {
      const res = await answerApprovalAction(id, a);
      if (!res.ok) window.alert(`Failed: ${res.error}`);
      router.refresh();
    });
  };

  // Fire-and-forget beside the anchor's own navigation. A 404 here means
  // another surface claimed the link first — harmless, the tab is already
  // opening and this row is about to disappear.
  const claim = () => {
    void fetch(`/api/v1/approvals/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'y', openedByClient: true }),
    })
      .catch(() => undefined)
      .finally(() => {
        router.refresh();
      });
  };

  if (url) {
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
          Dismiss
        </Button>
        <Button size="sm" href={url} target="_blank" rel="noreferrer" onClick={claim}>
          <Icons.ext />
          Open link
        </Button>
      </div>
    );
  }

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
