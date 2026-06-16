/**
 * Minimal Vercel REST helpers used by the CLI-login auth flow. The Sandbox SDK
 * requires a projectId on every call, but the OAuth access token harvested from
 * the CLI is team-scoped with no project — so after login we list the team's
 * projects (and optionally create one) to resolve a project to scope sandboxes
 * to. Plain `fetch`; no SDK. Each call takes the harvested `(token, teamId)`.
 */

const API = 'https://api.vercel.com';

export interface VercelProject {
  id: string;
  name: string;
}

class VercelApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VercelApiError';
  }
}

async function api(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail =
      (json as { error?: { message?: string } } | null)?.error?.message ??
      text ??
      res.statusText;
    throw new VercelApiError(res.status, `Vercel API ${res.status}: ${detail}`);
  }
  return json;
}

/**
 * Validate the token and return the authenticated user (probe / status).
 * `defaultTeamId` is the team the account (and the `sbx` CLI's default sandbox
 * project) is scoped to — the CLI-login flow falls back to it when the CLI store
 * records no selected team.
 */
export async function getUser(
  token: string,
): Promise<{ id: string; username?: string; defaultTeamId?: string }> {
  const json = (await api(token, '/v2/user')) as {
    user?: { id: string; username?: string; defaultTeamId?: string };
  };
  const user = json.user;
  if (!user?.id) throw new Error('Vercel /v2/user returned no user');
  return user;
}

/** List the team's projects (id + name). Paginates up to `limit` (default 100). */
export async function listProjects(
  token: string,
  teamId: string,
  limit = 100,
): Promise<VercelProject[]> {
  const json = (await api(
    token,
    `/v9/projects?teamId=${encodeURIComponent(teamId)}&limit=${limit}`,
  )) as { projects?: Array<{ id: string; name: string }> };
  return (json.projects ?? []).map((p) => ({ id: p.id, name: p.name }));
}

/**
 * Create a project under the team. On a 409 (name already taken) re-list and
 * return the existing project of that name, so the caller treats create as
 * idempotent.
 */
export async function createProject(
  token: string,
  teamId: string,
  name: string,
): Promise<VercelProject> {
  try {
    const json = (await api(token, `/v9/projects?teamId=${encodeURIComponent(teamId)}`, {
      method: 'POST',
      body: { name },
    })) as { id: string; name: string };
    return { id: json.id, name: json.name };
  } catch (err) {
    if (err instanceof VercelApiError && err.status === 409) {
      const existing = (await listProjects(token, teamId)).find((p) => p.name === name);
      if (existing) return existing;
    }
    throw err;
  }
}
