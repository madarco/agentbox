import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function DRow({
  k,
  v,
  mono,
  link,
}: {
  k: ReactNode;
  v: ReactNode;
  mono?: boolean;
  link?: string | null;
}) {
  return (
    <div className="flex items-baseline gap-4 px-5 py-2.5 max-sm:flex-col max-sm:gap-1">
      <div className="w-32 flex-none text-[13px] text-muted-foreground">{k}</div>
      <div
        className={cn(
          'min-w-0 flex-1 text-right text-[13px] max-sm:text-left [overflow-wrap:anywhere]',
          mono ? 'font-mono text-xs' : '',
        )}
      >
        {link ? (
          <Link className="cursor-pointer font-medium underline-offset-4 hover:underline" href={link}>
            {v}
          </Link>
        ) : (
          v
        )}
      </div>
    </div>
  );
}
