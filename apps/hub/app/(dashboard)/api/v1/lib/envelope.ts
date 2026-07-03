// One consistent JSON envelope for the whole public API. Success returns the
// resource/collection directly (stable, documented shapes); errors always return
// `{ error: { code, message, details? } }` with a correct HTTP status — never the
// exit-code-coupled statuses the internal relay surface uses.

export type ApiErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'unauthorized'
  | 'backend_unavailable'
  | 'conflict'
  | 'internal';

const STATUS_HINT: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  backend_unavailable: 503,
  internal: 500,
};

export function ok(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function fail(code: ApiErrorCode, message: string, details?: unknown): Response {
  const status = STATUS_HINT[code];
  return Response.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

// Map a backend ActionResult error into an envelope. Genuine missing-resource
// errors become 404; everything else is a 409 conflict (the op was rejected by
// the provider/state, not a client-input problem). The match is intentionally
// narrow — the backend's real not-found strings are "box not found: …",
// "unknown project …", and "no pending approval". A bare "unknown" (e.g. a Docker
// "unknown flag" / "unknown: not found" daemon message) must NOT be mistaken for
// a 404, or an operational failure would masquerade as a missing resource.
export function failFromAction(error: string): Response {
  const notFound =
    /\b(not found|no such|does not exist)\b/i.test(error) ||
    /\bunknown (project|box)\b/i.test(error) ||
    /no pending approval/i.test(error);
  return fail(notFound ? 'not_found' : 'conflict', error);
}
