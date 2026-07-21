import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Avatar({ className, fallback, ...props }: HTMLAttributes<HTMLSpanElement> & { fallback: ReactNode }) {
  return (
    <span
      className={cn(
        'grid h-7 w-7 flex-none place-items-center rounded-full bg-primary font-mono text-xs font-semibold text-primary-foreground',
        className,
      )}
      {...props}
    >
      {fallback}
    </span>
  );
}
