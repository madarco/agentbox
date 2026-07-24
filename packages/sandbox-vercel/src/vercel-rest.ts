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

// --- Git-backed control-plane deploy ---------------------------------------
// These drive the REST API so `agentbox hub setup --deploy vercel`
// builds the control plane FROM GitHub (no local upload). Shapes verified
// against the Vercel REST docs (project create is v11; deployments v13).

/** Append `teamId` as a query param (handles an existing `?`). */
function withTeam(path: string, teamId: string | undefined): string {
  if (!teamId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(teamId)}`;
}

export interface VercelProjectFull {
  id: string;
  name: string;
  framework?: string | null;
  rootDirectory?: string | null;
  /** Connected Git repo, when the project is Git-backed. */
  link?: { type?: string; org?: string; repo?: string } | null;
  targets?: { production?: { alias?: string[] } | null } | null;
}

/** GET a project by id or name; null on 404. */
export async function getProject(
  token: string,
  teamId: string | undefined,
  idOrName: string,
): Promise<VercelProjectFull | null> {
  try {
    return (await api(token, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}`, teamId))) as VercelProjectFull;
  } catch (err) {
    if (err instanceof VercelApiError && err.status === 404) return null;
    throw err;
  }
}

export interface CreateGitProjectInput {
  name: string;
  /** `owner/name` GitHub slug. */
  repo: string;
  rootDirectory: string;
  framework?: string;
}

/**
 * Create a Git-connected project. `gitRepository` connects the repo at create
 * time (there is no documented post-hoc connect endpoint, and it is not
 * PATCH-able — callers delete+recreate to re-connect). Throws the Vercel error
 * verbatim, including the "install the GitHub integration first" case when the
 * repo owner hasn't installed the Vercel GitHub App.
 */
export async function createGitProject(
  token: string,
  teamId: string | undefined,
  input: CreateGitProjectInput,
): Promise<VercelProjectFull> {
  // NB: a Git deployment checks out the WHOLE repo, so the app's turbo build
  // (`cd ../..`) sees the workspace without needing the "files outside root
  // directory" toggle — and `/v11/projects` rejects that field anyway.
  return (await api(token, withTeam('/v11/projects', teamId), {
    method: 'POST',
    body: {
      name: input.name,
      framework: input.framework ?? 'nextjs',
      rootDirectory: input.rootDirectory,
      gitRepository: { type: 'github', repo: input.repo },
    },
  })) as VercelProjectFull;
}

export async function deleteProject(
  token: string,
  teamId: string | undefined,
  idOrName: string,
): Promise<void> {
  await api(token, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}`, teamId), { method: 'DELETE' });
}

/** PATCH the settings that ARE updatable (not `gitRepository`). */
export async function patchProjectSettings(
  token: string,
  teamId: string | undefined,
  idOrName: string,
  settings: { framework?: string; rootDirectory?: string; sourceFilesOutsideRootDirectory?: boolean },
): Promise<void> {
  await api(token, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}`, teamId), {
    method: 'PATCH',
    body: settings,
  });
}

export interface VercelEnvVar {
  key: string;
  value: string;
  type?: 'encrypted' | 'plain' | 'sensitive';
  target?: string[];
}

/** Idempotent upsert (`?upsert=true` updates the value when the key exists). */
export async function upsertProjectEnv(
  token: string,
  teamId: string | undefined,
  idOrName: string,
  vars: VercelEnvVar[],
): Promise<void> {
  await api(token, withTeam(`/v10/projects/${encodeURIComponent(idOrName)}/env?upsert=true`, teamId), {
    method: 'POST',
    body: vars.map((v) => ({
      key: v.key,
      value: v.value,
      type: v.type ?? 'encrypted',
      target: v.target ?? ['production'],
    })),
  });
}

/** Whether the project already has an env var named `key` (any target). */
export async function projectHasEnv(
  token: string,
  teamId: string | undefined,
  idOrName: string,
  key: string,
): Promise<boolean> {
  const r = (await api(token, withTeam(`/v9/projects/${encodeURIComponent(idOrName)}/env`, teamId))) as {
    envs?: Array<{ key?: string }>;
  };
  return (r.envs ?? []).some((e) => e.key === key);
}

export interface CreateGitDeploymentInput {
  name: string;
  projectId: string;
  owner: string;
  repo: string;
  ref: string;
}

/** Trigger a production build FROM GitHub (gitSource = no file upload). */
export async function createGitDeployment(
  token: string,
  teamId: string | undefined,
  input: CreateGitDeploymentInput,
): Promise<{ id: string; url?: string }> {
  const res = (await api(token, withTeam('/v13/deployments?skipAutoDetectionConfirmation=1', teamId), {
    method: 'POST',
    body: {
      name: input.name,
      project: input.projectId,
      target: 'production',
      gitSource: { type: 'github', org: input.owner, repo: input.repo, ref: input.ref },
    },
  })) as { id?: string; url?: string };
  if (!res.id) throw new Error('Vercel deployment create returned no id');
  return { id: res.id, url: res.url };
}

export interface DeploymentStatus {
  readyState: string;
  url?: string;
  aliasFinal?: string | null;
  alias?: string[];
  errorMessage?: string;
  errorStep?: string;
}

export async function getDeployment(
  token: string,
  teamId: string | undefined,
  id: string,
): Promise<DeploymentStatus> {
  const d = (await api(token, withTeam(`/v13/deployments/${encodeURIComponent(id)}`, teamId))) as {
    readyState?: string;
    status?: string;
    url?: string;
    aliasFinal?: string | null;
    alias?: string[];
    errorMessage?: string;
    errorStep?: string;
  };
  return {
    readyState: d.readyState ?? d.status ?? 'UNKNOWN',
    url: d.url,
    aliasFinal: d.aliasFinal,
    alias: d.alias,
    errorMessage: d.errorMessage,
    errorStep: d.errorStep,
  };
}

/** The stable production alias (survives redeploys), or null. */
export async function getProductionAlias(
  token: string,
  teamId: string | undefined,
  idOrName: string,
): Promise<string | null> {
  const p = await getProject(token, teamId, idOrName);
  const aliases = p?.targets?.production?.alias;
  return Array.isArray(aliases) && aliases.length > 0 ? aliases[0]! : null;
}
