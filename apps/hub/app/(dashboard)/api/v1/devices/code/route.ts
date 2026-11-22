// POST /api/v1/devices/code — start enrolling a PC. Unauthenticated by design (the
// PC has no credential yet): it hands out nothing until the owner approves the
// returned `userCode` in the web UI, and the number of open codes is capped.
// An enrolled PC re-logging in sends its current token as `currentToken`, which
// marks the code as coming from that computer (`proven`).
import { fail, ok } from '../../lib/envelope';
import { devicesOrFail, jsonBody } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const devices = devicesOrFail();
  if (devices instanceof Response) return devices;
  const body = await jsonBody(req);
  if (!body) return fail('invalid_request', 'body must be a JSON object {deviceId, label}');
  const res = devices.startCode({
    deviceId: body.deviceId,
    label: body.label,
    currentToken: body.currentToken,
  });
  if (!res.ok) return fail(res.code, res.message);
  return ok(
    {
      deviceCode: res.deviceCode,
      userCode: res.userCode,
      verificationPath: `/devices?code=${encodeURIComponent(res.userCode)}`,
      expiresIn: res.expiresIn,
      interval: res.interval,
    },
    201,
  );
}
