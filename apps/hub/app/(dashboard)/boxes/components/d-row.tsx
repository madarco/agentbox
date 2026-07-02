import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function DRow({ k, v, mono, link }: { k: ReactNode; v: ReactNode; mono?: boolean; link?: string | null }) {
  return (
    <div className="grid grid-cols-[156px_1fr] items-baseline gap-4 px-4.5 p-3 max-sm:grid-cols-1 max-sm:gap-1">
      <div className="font-mono text-xs text-muted-foreground">{k}</div>
      <div className={cn('min-w-0 text-[13.5px]', mono ? 'font-mono text-[13px]' : '')}>
        {link ? (
          <Link className="cursor-pointer text-primary" href={link}>
            {v}
          </Link>
        ) : (
          v
        )}
      </div>
    </div>
  );
}
