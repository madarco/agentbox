// POST /api/v1/devices/approve — {userCode}. Owner only: the signed-in browser, or
// the API key together with the admin token (X-Agentbox-Admin-Token). Never the
// API key alone (it travels to the tray and thin clients, and a device token is
// an elevated credential) and never a device token (a stolen laptop must not be
// able to enroll a spare before it is revoked).
import { adminTokenPresented } from '@/lib/admin-token';
import { canApproveDevices, requestActor } from '@/lib/request-actor';
import { fail, ok } from '../../lib/envelope';
import { deviceJson, devicesOrFail, jsonBody } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  if (!canApproveDevices(requestActor(req), { adminToken: adminTokenPresented(req) })) {
    return fail(
      'forbidden',
      'only the hub owner (signed in, or the API key with the admin token) can approve devices',
    );
  }
  const body = await jsonBody(req);
  const userCode = typeof body?.userCode === 'string' ? body.userCode : '';
  if (!userCode) return fail('invalid_request', 'body must be {userCode}');
  const res = devices.approve(userCode);
  if (!res.ok) return fail('not_found', res.error);
  return ok({ device: deviceJson(res.device) });
}
