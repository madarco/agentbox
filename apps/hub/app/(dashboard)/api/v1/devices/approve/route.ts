// POST /api/v1/devices/approve — {userCode}. Owner only: the signed-in browser or
// the operator's API key, never a device token (a stolen laptop must not be able
// to enroll a spare before it is revoked).
import { canApproveDevices, requestActor } from '@/lib/request-actor';
import { fail, ok } from '../../lib/envelope';
import { deviceJson, devicesOrFail, jsonBody } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  if (!canApproveDevices(requestActor(req))) {
    return fail(
      'forbidden',
      'only the hub owner (signed in, or with the API key) can approve devices',
    );
  }
  const body = await jsonBody(req);
  const userCode = typeof body?.userCode === 'string' ? body.userCode : '';
  if (!userCode) return fail('invalid_request', 'body must be {userCode}');
  const res = devices.approve(userCode);
  if (!res.ok) return fail('not_found', res.error);
  return ok({ device: deviceJson(res.device) });
}
