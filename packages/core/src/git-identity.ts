/**
 * The committer identity a new box gets, when the machine building it is not
 * the user's (a remote hub). Pure data + validation so the CLI that sends it,
 * the hub that validates it and the provider that writes it share one rule.
 */

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Where a create's identity came from: the requesting PC's effective
 * `git config` (`request`), or the hub's `git.identity*` setting for creates
 * with no PC behind them (`hub-default`).
 */
export type GitIdentitySource = 'request' | 'hub-default';

export interface ResolvedGitIdentity extends GitIdentity {
  source: GitIdentitySource;
}

export const GIT_IDENTITY_MAX_LENGTH = 256;

/**
 * Why `value` cannot be a `user.name` / `user.email`, or null when it can. The
 * value lands in `git config` inside the box, so a newline or other control
 * character is refused outright rather than escaped.
 */
export function gitIdentityFieldProblem(value: unknown, field: string): string | null {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.trim().length === 0) return `${field} must not be empty`;
  if (value.length > GIT_IDENTITY_MAX_LENGTH) {
    return `${field} is too long (max ${String(GIT_IDENTITY_MAX_LENGTH)} characters)`;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return `${field} must not contain newlines or control characters`;
  }
  return null;
}

/** Parse `{ name, email }`; `error` names the first bad field. */
export function parseGitIdentity(
  value: unknown,
  field = 'gitIdentity',
): { ok: true; value: GitIdentity } | { ok: false; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `${field} must be an object of { name, email }` };
  }
  const v = value as Record<string, unknown>;
  const problem =
    gitIdentityFieldProblem(v.name, `${field}.name`) ??
    gitIdentityFieldProblem(v.email, `${field}.email`);
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    value: { name: (v.name as string).trim(), email: (v.email as string).trim() },
  };
}

/**
 * The identity a hub-built box is created with: the requester's first, then
 * the hub's default. Undefined leaves the provider to its own fallbacks (the
 * building machine's `git config`, then the generic agentbox identity).
 */
export function resolveCreateGitIdentity(
  request: GitIdentity | undefined,
  hubDefault: GitIdentity | undefined,
): ResolvedGitIdentity | undefined {
  if (request) return { name: request.name, email: request.email, source: 'request' };
  if (hubDefault) return { name: hubDefault.name, email: hubDefault.email, source: 'hub-default' };
  return undefined;
}
