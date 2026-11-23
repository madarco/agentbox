'use client';

import { Icons } from '@/components/icons';
import type { Finding } from './api';

/**
 * The secret scan's result. A finding is a heuristic hit (a key-shaped string,
 * a credential file name), shown so a person decides; nothing is blocked here.
 * `undefined` = the hub didn't report a scan (an older hub).
 */
export function Findings({ findings }: { findings: Finding[] | undefined }) {
  if (findings === undefined) return null;
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 font-mono text-xs text-[var(--green-ink)]">
        <Icons.check className="size-3.5" /> secret scan: clean
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--amber-line)] bg-[var(--amber-soft)] px-3 py-2">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Icons.warn className="size-3.5 text-[var(--amber)]" />
        secret scan: {findings.length} finding{findings.length === 1 ? '' : 's'}
      </div>
      <ul className="mt-1 list-none p-0 font-mono text-[11.5px] text-secondary-foreground">
        {findings.slice(0, 20).map((f, i) => (
          <li key={i}>
            {f.rule} in {f.path}:{f.line}
          </li>
        ))}
        {findings.length > 20 ? <li>… {findings.length - 20} more</li> : null}
      </ul>
    </div>
  );
}
