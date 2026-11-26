import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
  outline:
    'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  // An outlined button with destructive text: the hub never paints a solid red
  // button, a destroy confirms through a dialog instead.
  destructive:
    'border border-input bg-background text-destructive shadow-sm hover:border-[var(--red-line)] hover:bg-[var(--red-soft)] dark:bg-input/30',
  link: 'text-primary underline-offset-4 hover:underline',
};

const buttonSizes = {
  default: 'h-9 px-4 text-sm [&_svg]:size-4',
  sm: 'h-8 px-3 text-[13px] rounded-md [&_svg]:size-3.5',
  xs: 'h-7 px-2.5 text-xs rounded-md [&_svg]:size-3.5',
  icon: 'h-9 w-9 [&_svg]:size-4',
  'icon-sm': 'h-8 w-8 rounded-md [&_svg]:size-4',
  'icon-xs': 'h-7 w-7 rounded-md [&_svg]:size-3.5',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    variant?: keyof typeof buttonVariants;
    size?: keyof typeof buttonSizes;
  };

export function Button({
  className,
  variant = 'default',
  size = 'default',
  href,
  ...props
}: ButtonProps) {
  const classes = cn(
    'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
  if (href !== undefined) {
    return (
      <a className={classes} href={href} {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)} />
    );
  }
  return <button className={classes} {...(props as ButtonHTMLAttributes<HTMLButtonElement>)} />;
}
