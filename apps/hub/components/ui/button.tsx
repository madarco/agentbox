import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-[hsl(var(--accent-foreground))]',
  outline: 'border border-border bg-card text-secondary-foreground shadow-sm hover:border-[#a4a9b0] hover:text-foreground',
  ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
  destructive: 'border border-border bg-card text-destructive shadow-sm hover:border-[var(--red)] hover:bg-[var(--red-soft)]',
  link: 'text-primary underline-offset-4 hover:underline',
};

const buttonSizes = {
  default: 'h-9 px-3.5 text-[13px] [&_svg]:size-3.5',
  sm: 'h-[30px] px-2.5 text-xs rounded-md [&_svg]:size-[13px]',
  icon: 'h-9 w-9 [&_svg]:size-4',
  'icon-sm': 'h-7 w-7 rounded-md [&_svg]:size-[13px]',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    variant?: keyof typeof buttonVariants;
    size?: keyof typeof buttonSizes;
  };

export function Button({ className, variant = 'default', size = 'default', href, ...props }: ButtonProps) {
  const classes = cn(
    'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
  if (href !== undefined) {
    return <a className={classes} href={href} {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)} />;
  }
  return <button className={classes} {...(props as ButtonHTMLAttributes<HTMLButtonElement>)} />;
}
