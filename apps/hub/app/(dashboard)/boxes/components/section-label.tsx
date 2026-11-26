import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SectionLabel({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-3 mt-8 flex items-center gap-2.5', className)}>
      <h2 className="eyebrow !text-[11px] font-normal">{children}</h2>
      <span className="h-px flex-1 bg-border" />
      {right ? <div className="text-sm">{right}</div> : null}
    </div>
  );
}
