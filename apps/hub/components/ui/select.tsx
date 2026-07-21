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
          'h-9 w-full cursor-pointer appearance-none rounded-lg border border-input bg-card py-1 pl-3 pr-9 text-[13px] shadow-sm focus-visible:outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/15',
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
