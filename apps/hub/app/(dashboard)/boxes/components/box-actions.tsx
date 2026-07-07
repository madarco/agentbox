'use client';

import { useRouter } from 'next/navigation';
import { useTransition, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { destroyBoxAction, pauseBoxAction, renameBoxAction, resumeBoxAction, stopBoxAction } from '@/lib/boxes/actions';
import type { ActionResult } from '@/lib/boxes/backend-types';
import type { Box } from '@/lib/boxes/types';

export function BoxActions({ box, size }: { box: Box; size?: 'lg' }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const running = box.status === 'running';
  const paused = box.status === 'paused';
  const stopped = box.status === 'stopped';
  const lg = size === 'lg';
  const sz = lg ? 'sm' : 'icon-sm';

  const run = (e: MouseEvent, action: (id: string) => Promise<ActionResult>, confirmMsg?: string) => {
    e.stopPropagation();
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    startTransition(async () => {
      const res = await action(box.id);
      if (!res.ok) window.alert(`Action failed: ${res.error}`);
      router.refresh();
    });
  };

  const rename = (e: MouseEvent) => {
    e.stopPropagation();
    // Cosmetic label only — does not touch the container/branch/URL. Blank clears it.
    const next = window.prompt('Rename box (label only — leave blank to reset)', box.displayName ?? box.task);
    if (next === null) return;
    startTransition(async () => {
      const res = await renameBoxAction(box.id, next.trim());
      if (!res.ok) window.alert(`Rename failed: ${res.error}`);
      router.refresh();
    });
  };

  return (
    <div className={cn('flex gap-1.5', lg ? '' : 'justify-end')}>
      {paused ? (
        <Button
          variant={lg ? 'default' : 'outline'}
          size={sz}
          title="Resume"
          disabled={pending}
          className={lg ? '' : 'hover:border-[var(--green)] hover:bg-accent hover:text-[var(--green-ink)]'}
          onClick={(e) => run(e, resumeBoxAction)}
        >
          <Icons.play />
          {lg ? 'Resume' : null}
        </Button>
      ) : (
        <Button
          variant="outline"
          size={sz}
          disabled={pending || !running}
          title="Pause"
          className={lg ? '' : 'hover:border-[var(--amber)] hover:bg-[var(--amber-soft)] hover:text-[var(--amber)]'}
          onClick={(e) => run(e, pauseBoxAction)}
        >
          <Icons.pause />
          {lg ? 'Pause' : null}
        </Button>
      )}
      <Button
        variant="outline"
        size={sz}
        disabled={pending || stopped}
        title="Stop"
        onClick={(e) => run(e, stopBoxAction)}
      >
        <Icons.stop />
        {lg ? 'Stop' : null}
      </Button>
      <Button variant="outline" size={sz} disabled={pending} title="Rename" onClick={rename}>
        <Icons.pencil />
        {lg ? 'Rename' : null}
      </Button>
      <Button
        variant="destructive"
        size={sz}
        title="Destroy"
        disabled={pending}
        onClick={(e) => run(e, destroyBoxAction, `Destroy box ${box.id}? Its workspace volume is discarded. This cannot be undone.`)}
      >
        <Icons.trash />
        {lg ? 'Destroy' : null}
      </Button>
    </div>
  );
}
