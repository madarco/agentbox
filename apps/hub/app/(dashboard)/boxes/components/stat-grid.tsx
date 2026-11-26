import type { ReactNode } from 'react';
import type { Icon } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">{children}</div>;
}

export function Stat({
  k,
  v,
  mono,
  icon: IconComp,
}: {
  k: ReactNode;
  v: ReactNode;
  mono?: boolean;
  icon?: Icon;
}) {
  return (
    <Card className="min-w-0 p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {IconComp ? <IconComp className="size-3.5" /> : null}
        {k}
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 font-semibold tabular-nums [&>*]:truncate',
          mono ? 'font-mono text-sm font-medium' : 'text-lg',
        )}
      >
        {v}
      </div>
    </Card>
  );
}
