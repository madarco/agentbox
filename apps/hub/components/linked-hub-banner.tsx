'use client';

import { Icons } from '@/components/icons';
import { useStore } from '@/lib/boxes/store';

/**
 * Awareness banner for a PC's local hub that operates through a remote control
 * box (`relay.controlPlaneUrl` is set). `state.controlPlane` is populated only
 * on the localhost profile — the control box's own hub leaves it null (it IS the
 * remote hub) — so this naturally never renders on the deployed profile, where
 * it would link to itself.
 */
export function LinkedHubBanner() {
  const { state } = useStore();
  const cp = state.controlPlane;
  if (!cp) return null;

  return (
    <div className="flex items-center gap-2.5 border-b border-[var(--green-line)] bg-accent px-6 py-2 text-[12.5px] text-secondary-foreground max-md:px-4">
      <Icons.server className="size-[14px] flex-none text-[var(--green-ink)]" />
      <span className="min-w-0 truncate">
        This AgentBox instance is linked to a remote hub at{' '}
        <a
          href={cp.url}
          target="_blank"
          rel="noopener"
          className="font-mono text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {cp.url}
        </a>
      </span>
      <a
        href={cp.url}
        target="_blank"
        rel="noopener"
        className="ml-auto flex flex-none items-center gap-1 font-medium text-primary hover:opacity-80"
      >
        Open <Icons.ext className="size-[13px]" />
      </a>
    </div>
  );
}
