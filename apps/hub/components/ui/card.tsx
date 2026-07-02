import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type DivProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: DivProps) {
  return <div className={cn('rounded-xl border border-border bg-card text-card-foreground', className)} {...props} />;
}
export function CardHeader({ className, ...props }: DivProps) {
  return <div className={cn('flex flex-col space-y-1 p-5', className)} {...props} />;
}
export function CardTitle({ className, ...props }: DivProps) {
  return <div className={cn('text-[15px] font-semibold leading-none tracking-tight', className)} {...props} />;
}
export function CardDescription({ className, ...props }: DivProps) {
  return <div className={cn('text-[12.5px] text-muted-foreground', className)} {...props} />;
}
export function CardContent({ className, ...props }: DivProps) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}
export function CardFooter({ className, ...props }: DivProps) {
  return <div className={cn('flex items-center p-5 pt-0', className)} {...props} />;
}
