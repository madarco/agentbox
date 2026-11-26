import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Separator({
  className,
  vertical,
  ...props
}: HTMLAttributes<HTMLDivElement> & { vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn('shrink-0 bg-border', vertical ? 'h-4 w-px' : 'h-px w-full', className)}
      {...props}
    />
  );
}
