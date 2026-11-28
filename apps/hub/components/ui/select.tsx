import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  wrapperClassName?: string;
  /** `sm`: the 28px control for dense rows (text-xs, a smaller chevron). */
  size?: 'default' | 'sm';
};

// Native select with the shadcn trigger styling + a chevron overlay. The chevron
// inset and the text's room for it live here, per size, so a caller sets height,
// background or text color with `className` but never the right padding: every
// select keeps the same gap between the chevron and the border. Options take
// the popover colors so the native list stays readable in dark mode.
export function Select({
  wrapperClassName,
  className,
  size = 'default',
  children,
  ...props
}: SelectProps) {
  const sm = size === 'sm';
  return (
    <span className={cn('relative inline-flex', wrapperClassName)}>
      <select
        className={cn(
          'w-full cursor-pointer appearance-none truncate rounded-md border border-input bg-background shadow-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-60 dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground',
          sm ? 'h-7 py-0 pl-2.5 text-xs' : 'h-9 py-1 pl-3 text-sm',
          className,
          sm ? 'pr-7' : 'pr-9',
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground',
          sm ? 'right-2.5 size-3' : 'right-3 size-3.5',
        )}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}
