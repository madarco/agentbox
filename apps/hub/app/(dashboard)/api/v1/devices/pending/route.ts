// GET /api/v1/devices/pending — enrollment codes waiting for the owner's decision.
// DELETE /api/v1/devices/pending — deny them all (owner only): the way out when
// someone floods the list with codes.
import { canApproveDevices, requestActor } from '@/lib/request-actor';
import { fail, ok } from '../../lib/envelope';
import { devicesOrFail } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  return ok({
    pending: devices.listPending().map((p) => ({
      ...p,
      createdAt: new Date(p.createdAt).toISOString(),
      expiresAt: new Date(p.expiresAt).toISOString(),
    })),
  });
}

export function DELETE(req: Request): Response {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  if (!canApproveDevices(requestActor(req))) {
    return fail('forbidden', 'only the hub owner (signed in, or with the API key) can clear codes');
  }
  return ok({ denied: devices.clearPending() });
}
