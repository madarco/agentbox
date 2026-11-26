'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '@/components/ui/popover';
import {
  destroyBoxAction,
  pauseBoxAction,
  renameBoxAction,
  resumeBoxAction,
  stopBoxAction,
} from '@/lib/boxes/actions';
import type { ActionResult } from '@/lib/boxes/backend-types';
import type { Box } from '@/lib/boxes/types';
import { cn } from '@/lib/utils';

function useBoxOps(box: Box) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const run = (action: (id: string) => Promise<ActionResult>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    startTransition(async () => {
      const res = await action(box.id);
      if (!res.ok) window.alert(`Action failed: ${res.error}`);
      router.refresh();
    });
  };
  const rename = () => {
    // Cosmetic label only: does not touch the container, branch or URL. Blank clears it.
    const next = window.prompt(
      'Rename box (label only, leave blank to reset)',
      box.displayName ?? box.task,
    );
    if (next === null) return;
    startTransition(async () => {
      const res = await renameBoxAction(box.id, next.trim());
      if (!res.ok) window.alert(`Rename failed: ${res.error}`);
      router.refresh();
    });
  };
  const destroyMsg = `Destroy box ${box.id}? Its workspace volume is discarded. This cannot be undone.`;
  return { pending, run, rename, destroyMsg, router };
}

/**
 * A box's lifecycle actions. In a table row (default) one "more" menu; on the
 * box page (`size="lg"`) Pause/Resume and Stop as buttons, the rest in the menu.
 */
export function BoxActions({ box, size }: { box: Box; size?: 'lg' }) {
  const { pending, run, rename, destroyMsg, router } = useBoxOps(box);
  const running = box.status === 'running';
  const paused = box.status === 'paused';
  const stopped = box.status === 'stopped';
  const lg = size === 'lg';
  // Synthetic create-job box (id `job:<id>`, no real container): the only sensible
  // action is Dismiss (clear a failed create). Pause/Stop/Rename would error server-side.
  const synthetic = box.id.startsWith('job:');

  if (synthetic) {
    return (
      <div className={cn('flex', lg ? '' : 'justify-end')} onClick={(e) => e.stopPropagation()}>
        <Button
          variant={lg ? 'destructive' : 'ghost'}
          size={lg ? 'default' : 'icon-xs'}
          title="Dismiss"
          aria-label="Dismiss"
          className={lg ? '' : 'text-muted-foreground hover:text-destructive'}
          // Only errored creates can be dismissed; a `creating` job has nothing to clear yet.
          disabled={pending || box.status !== 'error'}
          onClick={() =>
            run(destroyBoxAction, `Dismiss failed box ${box.id}? This clears the failed create.`)
          }
        >
          <Icons.trash />
          {lg ? 'Dismiss' : null}
        </Button>
      </div>
    );
  }

  const menu = (
    <Popover
      align="end"
      className="w-52"
      trigger={(open, toggle) => (
        <Button
          variant={lg ? 'outline' : 'ghost'}
          size={lg ? 'icon' : 'icon-xs'}
          aria-label={`Actions for ${box.name || box.id}`}
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(!lg && 'text-muted-foreground', open && 'bg-accent')}
          onClick={toggle}
        >
          <Icons.more />
        </Button>
      )}
    >
      {(close) => {
        const pick = (fn: () => void) => () => {
          close();
          fn();
        };
        return (
          <div>
            <MenuLabel>{box.name || box.id}</MenuLabel>
            {lg ? null : (
              <MenuItem icon={Icons.ext} onClick={pick(() => router.push('/boxes/' + box.id))}>
                Open
              </MenuItem>
            )}
            <MenuItem
              icon={Icons.copy}
              onClick={pick(() => void navigator.clipboard?.writeText(box.id))}
            >
              Copy box id
            </MenuItem>
            <MenuItem icon={Icons.pencil} disabled={pending} onClick={pick(rename)}>
              Rename
            </MenuItem>
            {lg ? null : (
              <>
                <MenuSeparator />
                {paused ? (
                  <MenuItem
                    icon={Icons.play}
                    disabled={pending}
                    onClick={pick(() => run(resumeBoxAction))}
                  >
                    Resume
                  </MenuItem>
                ) : (
                  <MenuItem
                    icon={Icons.pause}
                    disabled={pending || !running}
                    onClick={pick(() => run(pauseBoxAction))}
                  >
                    Pause
                  </MenuItem>
                )}
                <MenuItem
                  icon={Icons.stop}
                  disabled={pending || stopped}
                  onClick={pick(() => run(stopBoxAction))}
                >
                  Stop
                </MenuItem>
              </>
            )}
            <MenuSeparator />
            <MenuItem
              icon={Icons.trash}
              destructive
              disabled={pending}
              onClick={pick(() => run(destroyBoxAction, destroyMsg))}
            >
              Destroy
            </MenuItem>
          </div>
        );
      }}
    </Popover>
  );

  if (!lg) {
    return (
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        {menu}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {paused ? (
        <Button disabled={pending} onClick={() => run(resumeBoxAction)}>
          <Icons.play />
          Resume
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={pending || !running}
          onClick={() => run(pauseBoxAction)}
        >
          <Icons.pause />
          Pause
        </Button>
      )}
      <Button variant="outline" disabled={pending || stopped} onClick={() => run(stopBoxAction)}>
        <Icons.stop />
        Stop
      </Button>
      {menu}
    </div>
  );
}
