'use client';

// The Usage page's header row, shared by both views so the switch stays put:
// the title on the left; the Work / AI usage switch and the view's own actions
// (Share, on the work view) on the right, as the Dashboard puts its buttons.

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Tabs } from '@/components/ui/tabs';

export type UsageViewId = 'work' | 'tokens';

/** `?view=tokens` is the AI usage view; anything else is the work view. */
export function parseUsageView(v: string | null): UsageViewId {
  return v === 'tokens' ? 'tokens' : 'work';
}

const COPY: Record<UsageViewId, { title: ReactNode; sub: string }> = {
  work: {
    title: (
      <>
        Usage <span className="serif text-[30px] text-[var(--green-ink)]">and output</span>
      </>
    ),
    sub: 'What your agents did side by side, what they shipped, and the hours it took.',
  },
  tokens: {
    title: (
      <>
        Usage <span className="serif text-[30px] text-[var(--green-ink)]">in tokens</span>
      </>
    ),
    sub: 'Tokens spent by the agent sessions this hub recorded, from every box, provider and PC that ships to it. Counted per model response; days in your time zone.',
  },
};

export function UsageHeader({ view, actions }: { view: UsageViewId; actions?: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const setView = (id: UsageViewId): void => {
    // Switching keeps every other param (subscription, range) for the way back.
    const q = new URLSearchParams(params.toString());
    if (id === 'tokens') q.set('view', 'tokens');
    else q.delete('view');
    const rest = q.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  };
  const copy = COPY[view];
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="min-w-0 basis-[28rem] grow">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">
          {copy.title}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{copy.sub}</p>
      </div>
      <div className="ml-auto flex flex-none flex-wrap items-center gap-2">
        <Tabs
          label="Usage view"
          items={[
            { id: 'work', label: 'Work' },
            { id: 'tokens', label: 'AI usage' },
          ]}
          value={view}
          onChange={setView}
        />
        {actions}
      </div>
    </div>
  );
}
