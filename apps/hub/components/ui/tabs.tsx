'use client';

import type { ReactNode } from 'react';
import type { Icon } from '@/components/icons';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: Icon;
  count?: number;
}

/** Segmented control (shadcn Tabs list), controlled. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  label,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** Accessible name for the tab list. */
  label?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'inline-flex h-9 items-center gap-0.5 rounded-lg bg-muted p-[3px] text-muted-foreground',
        className,
      )}
    >
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'inline-flex h-full cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 text-sm font-medium transition-[color,box-shadow] [&_svg]:size-4',
            value === t.id
              ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30'
              : 'bg-transparent hover:text-foreground',
          )}
        >
          {t.icon ? <t.icon /> : null}
          {t.label}
          {t.count !== undefined ? (
            <span className={cn('rounded px-1 text-xs tabular-nums', value === t.id && 'bg-muted')}>
              {t.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
