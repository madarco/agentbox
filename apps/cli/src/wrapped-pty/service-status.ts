import type { BoxStatus } from '@agentbox/ctl';

/**
 * Coarse box-service health for the attach footer's `(...)` slot. Returns null
 * when the box declares no services/tasks — the caller then falls back to the
 * agent activity / mode label. The user attached to the box cares about one
 * thing the agent activity can't tell them: did the `agentbox.yaml` services
 * (which boot in the background and take a while) come up?
 *
 * Three readings:
 * - `service error` — a service crashed/is unhealthy, or a setup task failed.
 * - `starting N/M…`  — services still converging; N up of M.
 * - `ready`          — every service up.
 *
 * Known limitation: a non-autostart service sitting at `pending` is
 * indistinguishable from one still starting, so it counts toward the
 * denominator and the box reads as `starting` until it runs. Acceptable —
 * services normally autostart. A `stopped` service (deliberately down) is
 * excluded from the denominator so it doesn't pin the box at `starting` forever.
 */
export function serviceStatusLabel(status: BoxStatus | null): string | null {
  if (!status) return null;
  const services = status.services ?? [];
  const tasks = status.tasks ?? [];
  if (services.length === 0 && tasks.length === 0) return null;

  const errored =
    services.some((s) => s.state === 'crashed' || s.state === 'unhealthy' || s.state === 'backoff') ||
    tasks.some((t) => t.state === 'failed');
  if (errored) return 'service error';

  const counted = services.filter((s) => s.state !== 'stopped');
  const total = counted.length;
  const up = counted.filter((s) => s.state === 'ready' || s.state === 'running').length;
  const settling =
    services.some((s) => s.state === 'pending' || s.state === 'waiting' || s.state === 'starting') ||
    tasks.some((t) => t.state === 'pending' || t.state === 'waiting' || t.state === 'running');

  // Services-less, task-only box: no count to show.
  if (total === 0) return settling ? 'starting…' : null;

  if (settling || up < total) return `starting ${String(up)}/${String(total)}…`;
  return 'ready';
}
