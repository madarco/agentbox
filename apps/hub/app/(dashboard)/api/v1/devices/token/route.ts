// POST /api/v1/devices/token — the enrolling PC's poll. Answers
// `authorization_pending` until the owner decides, then the device token exactly
// once (`access_denied` / `expired_token` otherwise). Unauthenticated like
// `/devices/code`: the 256-bit `deviceCode` is the proof.
import { fail, ok } from '../../lib/envelope';
import { deviceJson, devicesOrFail, jsonBody } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  const body = await jsonBody(req);
  const deviceCode = typeof body?.deviceCode === 'string' ? body.deviceCode : '';
  if (!deviceCode) return fail('invalid_request', 'body must be {deviceCode}');
  const res = devices.claim(deviceCode);
  switch (res.status) {
    case 'approved':
      return ok({ token: res.token, device: deviceJson(res.device) });
    case 'authorization_pending':
      return fail(res.status, 'waiting for the owner to approve this device in the hub');
    case 'access_denied':
      return fail(res.status, 'the owner denied this device');
    case 'expired_token':
      return fail(res.status, 'this enrollment code expired; run `agentbox hub login` again');
  }
}
