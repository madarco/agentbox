'use client';

/**
 * The box pages' toast stack (shadcn styling, AgentBox tokens).
 *
 * Extracted from `git-actions.tsx` when the bot panel needed the same thing:
 * two stacks with their own `_toastId` counters would both mount, and a second
 * copy of the styling is exactly the kind of drift that makes one panel's
 * "failed" look different from another's.
 */

import { useCallback, useState } from 'react';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  variant?: 'error';
}

/** What a child component is handed to raise a toast. */
export type OnToast = (t: Omit<Toast, 'id'>) => void;

let _toastId = 0;

export function useToasts(): {
  toasts: Toast[];
  push: OnToast;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback<OnToast>(
    (t) => {
      const id = ++_toastId;
      setToasts((ts) => [...ts, { id, ...t }]);
      setTimeout(() => dismiss(id), 4200);
    },
    [dismiss],
  );
  return { toasts, push, dismiss };
}

export function ToastStack({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[340px] max-w-[calc(100vw-40px)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="anim-pop pointer-events-auto relative flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 pr-9 shadow-[0_16px_40px_-18px_rgba(20,24,30,.35)]"
        >
          <span
            className={cn(
              'mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md border',
              t.variant === 'error'
                ? 'border-[var(--red-line)] bg-[var(--red-soft)] text-[var(--red)]'
                : 'border-[var(--green-line)] bg-accent text-primary',
            )}
          >
            {t.variant === 'error' ? (
              <Icons.warn className="size-3.5" />
            ) : (
              <Icons.check className="size-3.5" />
            )}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-tight">{t.title}</div>
            {t.detail ? (
              <div className="mt-0.5 break-words font-mono text-[11.5px] leading-normal text-muted-foreground">
                {t.detail}
              </div>
            ) : null}
          </div>
          <button
            className="absolute right-2.5 top-2.5 grid h-5 w-5 cursor-pointer place-items-center rounded border-0 bg-transparent text-[#a4a9b0] hover:text-foreground"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            <Icons.x className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
