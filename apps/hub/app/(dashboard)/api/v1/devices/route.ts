// GET /api/v1/devices — the PCs enrolled on this hub (`agentbox hub login`),
// revoked ones included. `current` is the caller's own device id when it called
// with a device token.
import { requestActor } from '@/lib/request-actor';
import { ok } from '../lib/envelope';
import { deviceJson, devicesOrFail } from './_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request): Response {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  const actor = requestActor(req);
  return ok({
    devices: devices.list().map(deviceJson),
    current: actor.kind === 'device' ? actor.deviceId : null,
  });
}
