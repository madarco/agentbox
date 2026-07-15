import { timingSafeEqual } from 'node:crypto';

/** Constant-time string compare (length leak only, like the HTTP handlers accept). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Whether an `/admin/*` request may proceed on the full relay/hub.
 *
 * Loopback callers are the host CLI/tray — always allowed (unchanged laptop
 * behavior). A non-loopback caller is allowed only when it presents the
 * configured admin bearer: the control box is network-reachable behind Caddy,
 * and its own resident worker + the PC (phase 4) reach `/admin/*` through the
 * public URL. Fail-closed: with no admin token configured the gate stays
 * loopback-only, so a laptop relay (which never sets one) exposes nothing new.
 */
export function adminGateAllows(
  isLoopback: boolean,
  bearer: string | undefined,
  adminToken: string,
): boolean {
  if (isLoopback) return true;
  if (adminToken.length === 0) return false;
  return Boolean(bearer) && timingSafeEqualStr(bearer ?? '', adminToken);
}
