// Shared by the /api/v1/devices routes: the service the custom server built, or
// the 503 a hub without one answers (a local single-PC hub, or vercel).
import type { DeviceRecord, DeviceService } from '@/lib/backend/devices';
import { fail } from '../lib/envelope';

export function devicesOrFail(): DeviceService | Response {
  const devices = globalThis.__AGENTBOX_HUB_DEVICES;
  if (!devices) {
    return fail(
      'backend_unavailable',
      'device enrollment needs a deployed or exposed hub (a local hub needs no login)',
    );
  }
  return devices;
}

/** The wire shape: epoch-ms fields as ISO strings, nulls kept. */
export function deviceJson(d: DeviceRecord): Record<string, unknown> {
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());
  return {
    id: d.id,
    label: d.label,
    createdAt: iso(d.createdAt),
    lastSeenAt: iso(d.lastSeenAt),
    revokedAt: iso(d.revokedAt),
    userId: d.userId,
  };
}

export async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
