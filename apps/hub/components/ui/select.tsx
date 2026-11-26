import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  wrapperClassName?: string;
};

// Native select with the shadcn trigger styling + a chevron overlay.
export function Select({ wrapperClassName, className, children, ...props }: SelectProps) {
  return (
    <span className={cn('relative inline-flex', wrapperClassName)}>
      <select
        className={cn(
          'h-9 w-full cursor-pointer appearance-none rounded-md border border-input bg-background py-1 pl-3 pr-9 text-sm shadow-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:bg-input/30',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}
