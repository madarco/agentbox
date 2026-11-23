// Shared plumbing for the /api/v1/skills routes: the custody store (reached
// through globalThis, like the custody routes, so @agentbox/relay stays out of
// Next's bundle) and the SkillsError → envelope mapping.
import { authMode } from '@/lib/auth-config';
import { SkillsError, type SkillsStore } from '@/lib/backend/skills';
import { custodyByteReadAuthorized } from '@/lib/custody-auth';
import { PEER_LOOPBACK_HEADER } from '@/lib/peer';
import { fail } from '../lib/envelope';

/**
 * Reading a skill's BYTES takes custody's elevated read, not the plain API key.
 * The library is in custody, and a skill can carry anything its author put in
 * it (the PC-side scan is a heuristic, and `--allow-findings` overrides it),
 * while the API key travels to the tray and every thin client. Same contract as
 * the custody blob route: the admin token, an enrolled device's own token, or
 * loopback on a local hub. A box never needs this: it reads its skills over the
 * relay's `/rpc`, authenticated as that box.
 */
export function skillBytesReadAllowed(req: Request): boolean {
  const provided = req.headers.get('x-agentbox-admin-token') ?? '';
  return custodyByteReadAuthorized({
    providedTokenIsDevice:
      provided.length > 0 && Boolean(globalThis.__AGENTBOX_HUB_DEVICES?.verifyToken(provided)),
    mode: authMode(),
    adminToken: process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '',
    providedToken: provided,
    isLoopback: req.headers.get(PEER_LOOPBACK_HEADER) === '1',
  });
}

export function skillsStoreOrFail(): SkillsStore | Response {
  const custody = globalThis.__AGENTBOX_HUB_CUSTODY;
  if (!custody) return fail('backend_unavailable', 'custody is not enabled on this hub');
  return custody;
}

export function failFromSkills(err: unknown, fallback: string): Response {
  if (err instanceof SkillsError) return fail(err.code, err.message);
  const msg = err instanceof Error ? err.message : fallback;
  // Matched by name so the store's error class never has to be imported here.
  if (err instanceof Error && err.name === 'CustodyTooLargeError') {
    return fail(
      'invalid_request',
      `${msg}. Raise AGENTBOX_CUSTODY_MAX_BLOB_BYTES on this hub to store a bigger skill.`,
    );
  }
  if (err instanceof Error && err.name === 'CustodyPathError') return fail('invalid_request', msg);
  return fail('internal', msg);
}

/**
 * `file:///` git sources read the hub's own disk, so only a loopback caller on
 * a local (non-password) hub may name one: that caller already owns the disk.
 */
export function fileGitAllowed(req: Request): boolean {
  return req.headers.get(PEER_LOOPBACK_HEADER) === '1' && authMode() !== 'password';
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = (await req.json().catch(() => null)) as unknown;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;
}
