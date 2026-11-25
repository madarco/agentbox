'use client';

// The top bar's subscription meter (hub settings 3b; design:
// control-shadcn/views-env.jsx SubsIndicator). The two in-use subscriptions
// closest to a limit, one thin bar per window (at most two), the highest
// percent or "limit" in red, and "+n" for the rest. Hover, focus or click
// opens the card with every in-use subscription's windows. "Quota" when no box
// uses one. A subscription with no limit data shows no bar: never a 0%.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icons } from '@/components/icons';
import { SubMark, SubMeters, TierBadge, subName, toneOf } from '@/components/subscription-meters';
import { agoText, rankInUse, topPct, useAccounts, type Account } from '@/lib/accounts-client';
import { subscriptionKey } from '@/lib/subscriptions';
import { cn } from '@/lib/utils';

function glyph(a: Account) {
  return a.kind === 'api-key'
    ? Icons.key
    : a.agent === 'claude'
      ? Icons.claude
      : a.agent === 'codex'
        ? Icons.codex
        : Icons.key;
}

function say(a: Account): string {
  if (!a.limits) return `${subName(a)}: no limit data`;
  return `${subName(a)}: ${a.limits.atLimit ? 'at limit' : `${String(Math.round(topPct(a)))}% used`}`;
}

export function SubsIndicator() {
  const { accounts } = useAccounts();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (): void => {
    clearTimeout(closeT.current);
    setOpen(true);
  };
  const hide = (): void => {
    clearTimeout(closeT.current);
    closeT.current = setTimeout(() => setOpen(false), 160);
  };
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(closeT.current), []);

  if (!accounts) return null;
  const ranked = rankInUse(accounts);
  const shown = ranked.slice(0, 2);
  const newest = ranked
    .flatMap((a) => (a.limits ? [a.limits.updatedAt] : []))
    .sort()
    .at(-1);
  const idle = accounts.length - ranked.length;

  return (
    <div className="relative max-sm:hidden" ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Subscriptions: ${shown.length ? shown.map(say).join('; ') : 'none in use'}`}
        className={cn(
          'inline-flex h-9 cursor-pointer items-center gap-3.5 rounded-lg border border-transparent bg-transparent px-2.5 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          open && 'bg-secondary',
        )}
        onClick={() => setOpen(!open)}
        onFocus={show}
      >
        {shown.map((a) => {
          const Icon = glyph(a);
          const full = a.limits?.atLimit === true;
          const pct = Math.min(100, topPct(a));
          const windows = (a.limits?.windows ?? []).slice(0, 2);
          return (
            <span key={subscriptionKey(a)} className="flex items-center gap-2">
              <Icon className="size-[13px] flex-none text-secondary-foreground" />
              {windows.length ? (
                <span className="flex w-11 flex-col gap-[3px]" aria-hidden="true">
                  {windows.map((w) => (
                    <span
                      key={w.id}
                      className="block h-[3px] overflow-hidden rounded-full bg-border"
                    >
                      <span
                        className={cn('block h-full rounded-full', toneOf(w.pct))}
                        style={{ width: `${String(Math.min(100, Math.max(0, w.pct)))}%` }}
                      />
                    </span>
                  ))}
                </span>
              ) : null}
              <span
                className={cn(
                  'min-w-[30px] font-mono text-[11.5px]',
                  full
                    ? 'font-medium text-[var(--red)]'
                    : pct >= 80
                      ? 'text-[#6a4e0c]'
                      : 'text-secondary-foreground',
                )}
              >
                {!a.limits ? '—' : full ? 'limit' : `${String(Math.round(pct))}%`}
              </span>
            </span>
          );
        })}
        {ranked.length > shown.length ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            +{ranked.length - shown.length}
          </span>
        ) : null}
        {!shown.length ? (
          <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <Icons.gauge className="size-[13px]" />
            Quota
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Subscriptions in use"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-[340px] rounded-xl border border-border bg-card shadow-[0_18px_40px_-18px_rgba(20,24,30,.35)]"
        >
          <div className="flex items-center border-b border-border/60 px-3.5 py-2.5 text-[13px] font-medium">
            Subscriptions in use
            <Link
              href="/settings/subscriptions"
              className="ml-auto font-mono text-[11px] font-normal text-primary hover:underline"
              onClick={() => setOpen(false)}
            >
              Manage
            </Link>
          </div>
          {ranked.map((a) => {
            const n = a.boxes.length;
            const full = a.limits?.atLimit === true;
            return (
              <div
                key={subscriptionKey(a)}
                className={cn(
                  'border-b border-border/60 px-3.5 py-3 last:border-b-0',
                  full && 'bg-[var(--amber-soft)]',
                )}
              >
                <div className="mb-2.5 flex items-center gap-2 text-[13px] font-medium">
                  <SubMark account={a} className="size-6 rounded-md [&_svg]:size-3.5" />
                  <span className="truncate">{subName(a)}</span>
                  <TierBadge account={a} />
                  <span className="ml-auto flex-none font-mono text-[11px] font-normal text-muted-foreground">
                    {n} {n === 1 ? 'box' : 'boxes'}
                  </span>
                </div>
                <SubMeters account={a} compact />
                {full ? (
                  <div className="mt-2.5 flex items-start gap-1.5 text-[11.5px] text-[#6a4e0c]">
                    <Icons.warn className="mt-px size-3 flex-none" />
                    <span>At its limit: its boxes wait until a window resets.</span>
                  </div>
                ) : null}
              </div>
            );
          })}
          {!ranked.length ? (
            <div className="px-3.5 py-4 text-[13px] text-muted-foreground">
              No box is using a subscription right now.
            </div>
          ) : null}
          <div className="flex items-center border-t border-border/60 px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
            <span>{newest ? agoText(newest) : 'no limit data yet'}</span>
            {idle > 0 ? <span className="ml-auto">{idle} more with no boxes</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
