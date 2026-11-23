// POST /api/v1/devices/:id/revoke — immediate: the device's next request is a 401
// and any stream it holds open (/api/events, a box stream, host-reach) is closed.
// Idempotent. A device may revoke itself (`agentbox hub logout`).
import { adminTokenPresented } from '@/lib/admin-token';
import { canManageDevice, requestActor } from '@/lib/request-actor';
import { fail, ok } from '../../../lib/envelope';
import { devicesOrFail } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  const { id } = await ctx.params;
  if (!canManageDevice(requestActor(req), id, { adminToken: adminTokenPresented(req) })) {
    return fail(
      'forbidden',
      'a device can only revoke itself; the hub owner can revoke any device',
    );
  }
  if (!devices.revoke(id)) return fail('not_found', `no device ${id}`);
  return ok({ ok: true });
}
