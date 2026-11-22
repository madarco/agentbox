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

/**
 * Whether the caller may enroll a new device. Not a device: a stolen laptop must
 * not be able to mint itself a spare token before it is revoked. The owner's
 * browser session and the operator's API key may. (No devices exist on a hub
 * without the password profile, so other actors never reach this.)
 */
export function canApproveDevices(actor: RequestActor): boolean {
  return actor.kind === 'session' || actor.kind === 'api-key';
}

/**
 * Whether the caller may revoke or rename device `id`: the owner may touch any
 * device; a device only itself (`agentbox hub logout`). A stolen laptop must not
 * be able to lock the owner's other computers out.
 */
export function canManageDevice(actor: RequestActor, id: string): boolean {
  if (canApproveDevices(actor)) return true;
  return actor.kind === 'device' && actor.deviceId === id;
}

/**
 * For a long-lived response (an SSE stream): call `close` the moment the device
 * that opened it is revoked, so revocation ends an open stream instead of waiting
 * for its next reconnect. Returns the unsubscribe; a no-op for other actors.
 */
export function closeOnDeviceRevoke(req: Request, close: () => void): () => void {
  const actor = requestActor(req);
  const devices = globalThis.__AGENTBOX_HUB_DEVICES;
  if (actor.kind !== 'device' || !devices) return () => {};
  return devices.onRevoked((id) => {
    if (id === actor.deviceId) close();
  });
}
