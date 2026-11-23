// The `PUT /api/v1/history/host` body, validated. Kept apart from
// history-host.ts so the route bundle does not pull in @agentbox/relay.

export interface HostSessionsPatch {
  enabled?: boolean;
  project?: { folder: string; mode: 'allow' | 'deny' | 'inherit' };
}

/** Validate a `PUT /history/host` body. */
export function parseHostSessionsPatch(
  body: unknown,
): { ok: true; value: HostSessionsPatch } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const out: HostSessionsPatch = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { ok: false, message: 'enabled must be a boolean' };
    out.enabled = b.enabled;
  }
  if (b.project !== undefined) {
    const p = b.project as Record<string, unknown> | null;
    if (
      !p ||
      typeof p.folder !== 'string' ||
      !p.folder.startsWith('/') ||
      (p.mode !== 'allow' && p.mode !== 'deny' && p.mode !== 'inherit')
    ) {
      return {
        ok: false,
        message: 'project must be {folder: <absolute path>, mode: allow|deny|inherit}',
      };
    }
    out.project = { folder: p.folder, mode: p.mode };
  }
  if (out.enabled === undefined && !out.project) {
    return { ok: false, message: 'expected enabled and/or project' };
  }
  return { ok: true, value: out };
}
