import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';

export function Command({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('overflow-hidden rounded-xl border border-border bg-card', className)} {...props} />;
}

export function CommandInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3.5">
      <Icons.search className="size-4 flex-none text-muted-foreground" />
      <input
        className={cn(
          'h-10 w-full border-0 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('max-h-[264px] overflow-y-auto', className)} {...props} />;
}

export function CommandEmpty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-[13px] text-muted-foreground">{children}</div>;
}
