import type { ReactNode } from 'react';
import { Icons } from '@/components/icons';

export function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card px-5 py-9 text-center text-[13.5px] text-muted-foreground">
      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg border border-border text-[#a4a9b0]">
        <Icons.box className="size-5" />
      </div>
      {children}
    </div>
  );
}
