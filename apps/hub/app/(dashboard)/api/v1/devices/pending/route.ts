// GET /api/v1/devices/pending — enrollment codes waiting for the owner's decision.
import { ok } from '../../lib/envelope';
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
