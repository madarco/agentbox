// PATCH /api/v1/devices/:id — {label}: rename an enrolled device.
import { fail, ok } from '../../lib/envelope';
import { devicesOrFail, jsonBody } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  const { id } = await ctx.params;
  const body = await jsonBody(req);
  const res = devices.rename(id, body?.label);
  if (!res.ok) {
    return fail(res.error === 'device not found' ? 'not_found' : 'invalid_request', res.error);
  }
  return ok({ ok: true });
}
