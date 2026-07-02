import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icons } from '@/components/icons';

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      className="mb-3.5 inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-xs text-muted-foreground hover:text-primary"
      href={to}
    >
      <Icons.arrowL className="size-[13px]" />
      {children}
    </Link>
  );
}
