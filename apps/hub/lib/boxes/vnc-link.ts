// Pure guards behind the two VNC-URL routes. Kept out of the route modules so
// vitest can cover them — apps/hub's vitest config scopes discovery to lib/**
// and test/** precisely so it never loads a Next route/page module.
import type { BoxRuntimeState } from '@agentbox/core';

/** Signed-URL lifetime bounds, mirroring the CLI's `agentbox screen --ttl` clamp. */
export const VNC_TTL_MIN = 1;
export const VNC_TTL_MAX = 86_400;

export type ParsedTtl = { ok: true; ttl?: number } | { ok: false; message: string };

/** `?ttl=` in seconds. Absent → undefined, i.e. the provider's own default (3600s). */
export function parseVncTtl(raw: string | null): ParsedTtl {
  if (raw === null || raw === '') return { ok: true };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, message: `ttl must be a whole number of seconds, got '${raw}'` };
  }
  const ttl = Number(raw);
  if (ttl < VNC_TTL_MIN || ttl > VNC_TTL_MAX) {
    return {
      ok: false,
      message: `ttl must be between ${String(VNC_TTL_MIN)} and ${String(VNC_TTL_MAX)} seconds, got ${raw}`,
    };
  }
  return { ok: true, ttl };
}

/**
 * Why this box can't serve a VNC URL right now, or null when it can.
 *
 * `state` must be an authoritative probe: a cloud box's persisted
 * `cloud.lastState` lags an out-of-band stop, and a signed preview URL minted
 * against a stopped sandbox resolves to a 502 the user can't diagnose.
 *
 * The "does not exist" wording is load-bearing: `failFromAction`'s narrow regex
 * is what turns a deleted sandbox into a 404 instead of a 409.
 */
export function vncUnavailableReason(
  box: { name?: string; vncEnabled?: boolean; vncPassword?: string },
  state: BoxRuntimeState,
): string | null {
  if (!box.vncEnabled) return 'VNC is not enabled for this box (created with --no-vnc)';
  if (!box.vncPassword) {
    return 'this box has no VNC password recorded; recreate it to enable the desktop';
  }
  if (state === 'missing') {
    return `the sandbox for ${box.name ?? 'this box'} does not exist any more — was it deleted?`;
  }
  if (state !== 'running') return `box is ${state} — start it before opening the desktop`;
  return null;
}
