import Link from 'next/link';
import type { ReactNode } from 'react';

/** The line above a public share: whose it is, when, and where it was made. */
export function ShareHeader({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center gap-x-4 gap-y-1 px-6 pt-6 font-mono text-[13px] text-fd-muted-foreground">
      <div className="min-w-0 flex-1">{children}</div>
      <Link href="/" className="flex items-center gap-2 hover:text-fd-foreground">
        <img src="/logo.svg" alt="" width={16} height={16} className="dark:invert" />
        made with AgentBox
      </Link>
    </div>
  );
}
