import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icons } from '@/components/icons';

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      className="mb-4 inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      href={to}
    >
      <Icons.arrowL className="size-4" />
      {children}
    </Link>
  );
}
