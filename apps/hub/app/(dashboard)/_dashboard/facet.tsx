'use client';

import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/** A data-table toolbar filter: a dashed button that opens a checklist. */
export function Facet({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const n = selected.length;
  return (
    <Popover
      align="start"
      className="w-56 p-0"
      trigger={(open, toggle) => (
        <Button
          variant="outline"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn('border-dashed', open && 'bg-accent')}
          onClick={toggle}
        >
          <Icons.plus />
          {title}
          {n ? (
            <>
              <Separator vertical className="mx-0.5" />
              {n > 2 ? (
                <Badge variant="secondary" className="rounded-sm px-1 font-sans font-normal">
                  {n} selected
                </Badge>
              ) : (
                selected.map((s) => (
                  <Badge key={s} variant="secondary" className="rounded-sm px-1 font-sans font-normal">
                    {options.find((o) => o.value === s)?.label ?? s}
                  </Badge>
                ))
              )}
            </>
          ) : null}
        </Button>
      )}
    >
      {() => (
        <div className="p-1">
          {options.length === 0 ? (
            <div className="px-2 py-3 text-center text-sm text-muted-foreground">Nothing to filter</div>
          ) : null}
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() =>
                  onChange(on ? selected.filter((x) => x !== o.value) : [...selected, o.value])
                }
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span
                  className={cn(
                    'grid size-4 flex-none place-items-center rounded-[4px] border',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {on ? <Icons.check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{o.count}</span>
              </button>
            );
          })}
          {n ? (
            <>
              <div className="-mx-1 my-1 h-px bg-border" />
              <button
                type="button"
                onClick={() => onChange([])}
                className="w-full cursor-pointer rounded-sm border-0 bg-transparent py-1.5 text-center text-sm hover:bg-accent"
              >
                Clear filters
              </button>
            </>
          ) : null}
        </div>
      )}
    </Popover>
  );
}
