import { Badge } from '@/components/ui/badge';
import { statusMeta, type BoxStatus } from '@/lib/boxes/types';

export function StatusBadge({ status }: { status: BoxStatus }) {
  const meta = statusMeta[status] ?? statusMeta.stopped;
  return (
    <Badge className={meta.badgeClass}>
      <span className="badge-dot" />
      {meta.label}
    </Badge>
  );
}
