import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

const TIP =
  'Persistent (always-on): never auto-paused, never pruned, and started again after a host reboot';

/** Lock marker for an always-on box (`Box.persistent`). The caller gates on the flag. */
export function PersistentMark({ className }: { className?: string }) {
  return (
    <span
      title={TIP}
      aria-label="Persistent box"
      className="inline-flex flex-none items-center text-muted-foreground"
    >
      <Icons.lock className={cn('size-3.5', className)} />
    </span>
  );
}
