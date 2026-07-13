/**
 * Detect "the cloud rejected my credentials" across backends, and carry it as
 * an actionable error instead of whatever opaque shape the SDK threw.
 *
 * Same idea as `snapshot-error.ts`: one conservative classifier so the
 * lifecycle code can branch on *meaning* rather than each backend's error
 * dialect. The immediate user is AWS (an SSO session expires ~daily, so
 * "expired token" is a routine condition, not an edge case), but the shapes
 * cover the generic 401/403 dialects the other backends speak.
 *
 * Being conservative matters more than being complete here: a false positive
 * turns a real "instance not found" into "please log in again", which sends
 * the user chasing the wrong fix. `Invalid<X>ID.NotFound` and friends must
 * never classify as auth.
 */

import { UserFacingError } from '@agentbox/core';

/**
 * Error codes/names that unambiguously mean the caller's credentials were
 * rejected (expired, invalid, unresolvable) — not that a resource is missing.
 * AWS EC2 query-protocol codes + SDK credential-chain error names.
 */
const AUTH_CODE_RE =
  /^(ExpiredToken|ExpiredTokenException|TokenRefreshRequired|AuthFailure|UnauthorizedOperation|InvalidClientTokenId|UnrecognizedClientException|SignatureDoesNotMatch|CredentialsProviderError|SSOTokenProviderFailure|AccessDenied|AccessDeniedException)$/;

/** Message shapes for SDKs that don't set a stable code. */
const AUTH_MESSAGE_RE =
  /(token (is )?expired|sso session|security token.*(invalid|expired)|credential(s)? (could not be|not) (loaded|resolved|found)|aws sso login)/i;

/**
 * True when `err` means "the cloud rejected or could not resolve the caller's
 * credentials". False for resource-level failures (`Invalid…ID.NotFound`,
 * capacity, quota) and anything ambiguous.
 */
export function isAuthError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : '';
  const name = typeof e.name === 'string' ? e.name : '';
  if (AUTH_CODE_RE.test(code) || AUTH_CODE_RE.test(name)) return true;
  const status = e.response?.status ?? e.statusCode ?? e.status;
  if (status === 401 || status === 403) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return AUTH_MESSAGE_RE.test(message);
}

/**
 * Actionable "you are not logged in to <provider>" error. Extends
 * `UserFacingError` so the CLI renders it stack-free; carries the provider and
 * the fix so daemons (hub, queued worker) can raise a re-auth prompt without
 * re-parsing the message.
 */
export class NotAuthenticatedError extends UserFacingError {
  /** Provider name, e.g. 'aws'. */
  readonly provider: string;
  /** One-line fix, e.g. 'run `aws sso login --profile x`'. */
  readonly hint: string;

  constructor(provider: string, message: string, hint: string) {
    super(message);
    this.name = 'NotAuthenticatedError';
    this.provider = provider;
    this.hint = hint;
  }
}

/** `instanceof` that survives bundling/dual-publish boundaries (same trick as UserFacingError). */
export function isNotAuthenticatedError(err: unknown): err is NotAuthenticatedError {
  return (
    err instanceof NotAuthenticatedError ||
    (err instanceof Error && err.name === 'NotAuthenticatedError')
  );
}
