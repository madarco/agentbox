import type { ReactNode } from 'react';

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[.1em] text-[#a4a9b0]">
      {children}
      <span className="h-px flex-1 bg-border" />
      {right ?? null}
    </div>
  );
}
