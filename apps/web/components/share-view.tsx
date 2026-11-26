import { UsageView } from '@agentbox/usage-view/react';
import type { UsageShare } from '@agentbox/usage-view';
import { ShareHeader } from './share-header';

export function ShareView({ share, sharedOn }: { share: UsageShare; sharedOn: string }) {
  return (
    <>
      <ShareHeader>
        {share.name ? (
          <>
            shared by{' '}
            <span className="text-fd-foreground" title="A name the sharer typed, not verified">
              {share.name}
            </span>{' '}
            · {sharedOn}
          </>
        ) : (
          <>shared {sharedOn}</>
        )}
      </ShareHeader>
      <UsageView data={share} />
    </>
  );
}
