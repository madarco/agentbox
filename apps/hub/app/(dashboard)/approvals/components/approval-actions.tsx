'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { answerApprovalAction } from '@/lib/boxes/actions';
import type { Approval } from '@/lib/boxes/types';

// Approve / Deny for one pending host-action approval. Answering resolves the
// parked in-box RPC on the relay; the SSE `change` refresh then drops the row.
//
// `open-link` approvals swap Approve for "Open link": the URL is opened HERE,
// in the viewer's browser (window.open inside the click handler, so popup
// blockers treat it as user-initiated), and the answer carries
// `openedByClient` so the relay's host-open fallback stays quiet. This is
// what keeps the flow working when the relay runs on a remote control plane —
// the host never needs a browser.
export function ApprovalActions({
  approval,
}: {
  approval: Pick<Approval, 'id' | 'kind' | 'url' | 'userCode'>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isOpenLink = approval.kind === 'open-link' && typeof approval.url === 'string';

  const answer = (a: 'y' | 'n', openedByClient?: boolean) => {
    startTransition(async () => {
      const res = await answerApprovalAction(approval.id, a, openedByClient);
      if (!res.ok) window.alert(`Failed: ${res.error}`);
      router.refresh();
    });
  };

  const openLink = () => {
    // Open first, then answer: the popup must be born inside the user
    // gesture, and a failed answer must not eat the tab.
    window.open(approval.url, '_blank', 'noopener,noreferrer');
    answer('y', true);
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
        {isOpenLink ? 'Dismiss' : 'Deny'}
      </Button>
      {isOpenLink ? (
        <Button size="sm" disabled={pending} onClick={openLink}>
          <Icons.ext />
          Open link
        </Button>
      ) : (
        <Button size="sm" disabled={pending} onClick={() => answer('y')}>
          <Icons.check />
          Approve
        </Button>
      )}
    </div>
  );
}
