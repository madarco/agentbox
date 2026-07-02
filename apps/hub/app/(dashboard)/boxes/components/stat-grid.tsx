import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import type { Icon } from '@/components/icons';

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <Card className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] divide-x divide-border/60 overflow-hidden">
      {children}
    </Card>
  );
}

export function Stat({ k, v, mono, icon: IconComp }: { k: ReactNode; v: ReactNode; mono?: boolean; icon?: Icon }) {
  return (
    <div className="px-4.5 p-4">
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[.06em] text-[#a4a9b0]">{k}</div>
      <div className={cn('flex items-center gap-2 font-semibold tracking-[-0.01em]', mono ? 'font-mono text-sm font-medium' : 'text-base')}>
        {IconComp ? <IconComp className="size-[15px] text-muted-foreground" /> : null}
        {v}
      </div>
    </div>
  );
}
