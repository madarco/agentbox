'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';

type DivProps = HTMLAttributes<HTMLDivElement>;

export function Dialog({
  onClose,
  className,
  children,
}: {
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="anim-fade fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[rgba(20,24,30,.42)] p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'anim-pop relative m-auto w-full max-w-[500px] rounded-2xl border border-border bg-card shadow-[0_40px_80px_-30px_rgba(20,24,30,.5)]',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <button
          className="absolute right-4 top-4 grid h-7 w-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-[#a4a9b0] transition-colors hover:bg-secondary hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
        >
          <Icons.x style={{ width: 15, height: 15 }} />
        </button>
      </div>
    </div>
  );
}

export function DialogHeader({ className, ...props }: DivProps) {
  return <div className={cn('flex items-start gap-3 border-b border-border/70 px-5 pb-4 pt-5', className)} {...props} />;
}
export function DialogTitle({ className, ...props }: DivProps) {
  return <div className={cn('text-base font-semibold leading-tight tracking-tight', className)} {...props} />;
}
export function DialogDescription({ className, ...props }: DivProps) {
  return <div className={cn('mt-1 font-mono text-xs text-muted-foreground', className)} {...props} />;
}
export function DialogBody({ className, ...props }: DivProps) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: DivProps) {
  return (
    <div
      className={cn('flex justify-end gap-2.5 rounded-b-2xl border-t border-border/70 bg-background px-5 py-3.5', className)}
      {...props}
    />
  );
}
export function DialogIcon({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-9 w-9 flex-none place-items-center rounded-lg border border-[var(--green-line)] bg-accent text-primary [&_svg]:size-[17px]">
      {children}
    </span>
  );
}
