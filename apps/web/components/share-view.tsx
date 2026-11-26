import Link from 'next/link';
import { UsageView } from '@agentbox/usage-view/react';
import type { UsageShare } from '@agentbox/usage-view';
import { ShareHeader } from './share-header';

export function ShareView({ share, sharedOn }: { share: UsageShare; sharedOn: string }) {
  return (
    <>
      <ShareHeader>
        <Link href={`/u/${share.handle}`} className="text-fd-foreground hover:underline">
          {share.handle}
        </Link>{' '}
        · shared {sharedOn}
      </ShareHeader>
      <UsageView data={share} />
    </>
  );
}
