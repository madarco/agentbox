import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Icon } from '@/components/icons';

export function Alert({
  className,
  icon: IconComp,
  title,
  children,
}: {
  className?: string;
  icon?: Icon;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn('relative flex w-full items-start gap-3 rounded-xl border p-4', className)}>
      {IconComp ? <IconComp className="mt-0.5 size-4 flex-none" /> : null}
      <div className="min-w-0">
        {title ? <div className="mb-0.5 text-[13.5px] font-semibold leading-tight">{title}</div> : null}
        <div className="text-[12.5px] leading-normal">{children}</div>
      </div>
    </div>
  );
}
