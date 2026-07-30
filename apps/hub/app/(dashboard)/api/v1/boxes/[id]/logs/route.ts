// GET /api/v1/boxes/:id/logs — a box service log (or the ctl-daemon log with
// `daemon=1`). Two shapes on one route:
//   follow=0 (default): JSON snapshot `{ output }` — a bounded `--tail` dump.
//   follow=1:           SSE stream (open / log* / end) the CLI tails live; the hub
//                       spawns the in-box `agentbox-ctl logs --follow` (docker exec
//                       or the provider attach argv) and pipes stdout to SSE.
// Needs the in-process host backend; the Postgres/plane path 503s.
import { streamBoxLog } from '@/lib/box-log-stream';
import { backendOrNull } from '../../../lib/backend';
import { fail, failFromAction, ok } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (id.startsWith('job:')) {
    return fail('conflict', `box ${id} is still being created; logs are not available yet`);
  }
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  const url = new URL(req.url);
  const daemon = url.searchParams.get('daemon') === '1';
  const follow = url.searchParams.get('follow') === '1';
  const service = url.searchParams.get('service') ?? undefined;
  const tailRaw = Number.parseInt(url.searchParams.get('tail') ?? '', 10);
  const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? tailRaw : 200;
  if (!daemon && !service) {
    return fail('invalid_request', 'service is required (or pass daemon=1 for the ctl-daemon log)');
  }

  if (!follow) {
    const snap = await backend.boxLogSnapshot(id, { service, tail, daemon });
    if (!snap.ok) return failFromAction(snap.error, { exitCode: snap.exitCode });
    return ok({ output: snap.stdout ?? '' });
  }

  const spec = await backend.boxLogAttach(id, { service, tail, daemon });
  if (!spec.ok) return failFromAction(spec.error);
  return streamBoxLog(req, spec);
}
