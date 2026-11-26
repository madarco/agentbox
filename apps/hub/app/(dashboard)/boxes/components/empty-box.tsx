import type { ReactNode } from 'react';
import { Icons, type Icon } from '@/components/icons';

export function EmptyBox({ children, icon: IconComp = Icons.box }: { children: ReactNode; icon?: Icon }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
      <div className="mb-4 grid size-10 place-items-center rounded-lg border border-border bg-background text-foreground shadow-sm">
        <IconComp className="size-5" />
      </div>
      {children}
    </div>
  );
}
