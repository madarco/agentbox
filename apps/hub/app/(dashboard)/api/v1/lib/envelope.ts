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
  | 'manager_unreachable'
  | 'wrong_host'
  | 'forbidden'
  | 'rate_limited'
  | 'payload_too_large'
  // A site the hub calls on the caller's behalf (agent-box.sh for a usage share) failed.
  | 'upstream_error'
  // Device enrollment (RFC 8628 vocabulary): the CLI's poll keeps going on the
  // first, and stops on the other two.
  | 'authorization_pending'
  | 'access_denied'
  | 'expired_token'
  | 'internal';

const STATUS_HINT: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  payload_too_large: 413,
  authorization_pending: 400,
  access_denied: 400,
  expired_token: 400,
  conflict: 409,
  manager_unreachable: 409,
  // The op is fine, this hub is the wrong machine for it: `details.host` names
  // the one that runs the manager, and the client retries there.
  wrong_host: 409,
  backend_unavailable: 503,
  upstream_error: 502,
  internal: 500,
};

export function ok(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function fail(code: ApiErrorCode, message: string, details?: unknown): Response {
  const status = STATUS_HINT[code];
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

/**
 * A manager op's refusal. `wrong_host` keeps its `details.host` so the client
 * can retry against the hub on that machine; everything else falls through to
 * the not-found/conflict split.
 */
export function failFromManager(
  res: { error: string; code?: string; details?: unknown },
  extra?: unknown,
): Response {
  if (res.code === 'wrong_host') return fail('wrong_host', res.error, res.details);
  if (res.code === 'manager_unreachable') {
    return fail('manager_unreachable', res.error, res.details);
  }
  return failFromAction(res.error, extra);
}

// Map a backend ActionResult error into an envelope. Genuine missing-resource
// errors become 404; everything else is a 409 conflict (the op was rejected by
// the provider/state, not a client-input problem). The match is intentionally
// narrow — the backend's real not-found strings are "box not found: …",
// "unknown project/workspace/task/job/manager …", and "no pending approval". A bare
// "unknown" (e.g. a Docker
// "unknown flag" / "unknown: not found" daemon message) must NOT be mistaken for
// a 404, or an operational failure would masquerade as a missing resource.
export function failFromAction(error: string, details?: unknown): Response {
  const notFound =
    /\b(not found|no such|does not exist)\b/i.test(error) ||
    /\bunknown (project|box|workspace|task|job|manager)\b/i.test(error) ||
    /no pending approval/i.test(error);
  return fail(notFound ? 'not_found' : 'conflict', error, details);
}
