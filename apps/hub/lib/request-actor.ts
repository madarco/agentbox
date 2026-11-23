// The authenticated caller of an `/api/v1` request, as the gate decided it.
//
// proxy.ts stamps `x-agentbox-actor` on every request it lets through and
// overwrites whatever the client sent, so a route can trust it. Stage 1 knows
// devices; Stage 2 adds a user beside the device.
import type { GateActor } from './session-gate';

export const ACTOR_HEADER = 'x-agentbox-actor';

export type RequestActor =
  | { kind: 'device'; deviceId: string }
  | { kind: 'api-key' | 'session' | 'hub-token' | 'open' | 'anonymous' };

export function parseActor(raw: string | null | undefined): RequestActor {
  const v = (raw ?? '').trim() as GateActor | '';
  if (v.startsWith('device:')) {
    const deviceId = v.slice('device:'.length);
    if (deviceId) return { kind: 'device', deviceId };
  }
  switch (v) {
    case 'api-key':
    case 'session':
    case 'hub-token':
    case 'open':
      return { kind: v };
    default:
      return { kind: 'anonymous' };
  }
}

export function requestActor(req: Request): RequestActor {
  return parseActor(req.headers.get(ACTOR_HEADER));
}

/** What the caller proved beyond its actor (the admin token, checked by the route). */
export interface OwnerProof {
  adminToken: boolean;
}

/**
 * Whether the caller may enroll a new device (approve, deny, list pending). A
 * signed-in owner session may; so may the API key, but only together with the
 * admin token: the key alone travels to the tray and every thin client, and an
 * enrolled device's token is an elevated credential (custody byte reads), so
 * the key must not be able to mint one. Never a device: a stolen laptop must not
 * mint itself a spare token before it is revoked. (No devices exist on a hub
 * without the password profile, so other actors never reach this.)
 */
export function canApproveDevices(
  actor: RequestActor,
  proof: OwnerProof = { adminToken: false },
): boolean {
  return actor.kind === 'session' || (actor.kind === 'api-key' && proof.adminToken);
}

/**
 * Whether the caller may revoke or rename device `id`: the owner (as for
 * {@link canApproveDevices}) may touch any device; a device only itself
 * (`agentbox hub logout`). A stolen laptop must not be able to lock the owner's
 * other computers out.
 */
export function canManageDevice(
  actor: RequestActor,
  id: string,
  proof: OwnerProof = { adminToken: false },
): boolean {
  if (canApproveDevices(actor, proof)) return true;
  return actor.kind === 'device' && actor.deviceId === id;
}
