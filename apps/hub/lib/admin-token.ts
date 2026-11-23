// The hub's admin token (`AGENTBOX_RELAY_ADMIN_TOKEN`) as a second credential on
// top of the API key. The API key travels to the tray, the web and every thin
// client, so an action that mints a credential (enrolling a device) needs more
// than that key: a signed-in session, or the key plus this token.
import { timingSafeEqual } from 'node:crypto';

export const ADMIN_TOKEN_HEADER = 'x-agentbox-admin-token';

/** Timing-safe; false when the hub has no admin token configured. */
export function adminTokenMatches(provided: string, expected: string): boolean {
  if (expected.length === 0 || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether `req` presents this hub's admin token. */
export function adminTokenPresented(req: Request): boolean {
  return adminTokenMatches(
    req.headers.get(ADMIN_TOKEN_HEADER) ?? '',
    process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '',
  );
}
