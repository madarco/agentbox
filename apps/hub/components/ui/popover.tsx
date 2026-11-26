'use client';

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Icon } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * A small anchored popover (dropdown menu). `trigger` renders the anchor and
 * gets `(open, toggle)`; `children` gets `close`. Closes on outside click,
 * Escape, scroll and resize.
 */
export function Popover({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
  className,
}: {
  trigger: (open: boolean, toggle: (e?: MouseEvent) => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  className?: string;
}) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = pos !== null;
  const close = () => setPos(null);

  // Rendered in a portal at a fixed position: a menu inside a table or a card
  // would otherwise be clipped by the container's overflow.
  const place = (): CSSProperties | null => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return null;
    return {
      position: 'fixed',
      ...(side === 'top'
        ? { bottom: window.innerHeight - r.top + 6 }
        : { top: r.bottom + 6 }),
      ...(align === 'end' ? { right: window.innerWidth - r.right } : { left: r.left }),
    };
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || panel.current?.contains(t)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    };
    const onMove = () => setPos(null);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  return (
    <div ref={anchor} className="relative inline-flex">
      {trigger(open, (e) => {
        e?.stopPropagation();
        setPos(open ? null : place());
      })}
      {pos
        ? createPortal(
            <div
              ref={panel}
              role="menu"
              style={pos}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'anim-drop z-[70] min-w-[12rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
                className,
              )}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function MenuItem({
  icon: IconComp,
  children,
  onClick,
  destructive,
  shortcut,
  disabled,
  href,
  external,
}: {
  icon?: Icon;
  children: ReactNode;
  onClick?: () => void;
  destructive?: boolean;
  shortcut?: string;
  disabled?: boolean;
  href?: string;
  external?: boolean;
}) {
  const className = cn(
    'flex w-full cursor-pointer select-none items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
    destructive ? 'text-destructive hover:bg-[var(--red-soft)]' : 'text-popover-foreground',
  );
  const inner = (
    <>
      {IconComp ? <IconComp className={destructive ? '' : 'text-muted-foreground'} /> : null}
      <span className="flex-1">{children}</span>
      {shortcut ? (
        <span className="ml-auto text-xs tracking-widest text-muted-foreground">{shortcut}</span>
      ) : null}
    </>
  );
  if (href) {
    return (
      <a
        role="menuitem"
        className={className}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener' : undefined}
        onClick={onClick}
      >
        {inner}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" disabled={disabled} onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{children}</div>;
}

export function MenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-border" />;
}
