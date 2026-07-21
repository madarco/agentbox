import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitDeployment,
  createGitProject,
  createProject,
  getDeployment,
  getProductionAlias,
  getProject,
  getUser,
  listProjects,
  upsertProjectEnv,
} from '../src/vercel-rest.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getUser', () => {
  it('returns the user on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: { id: 'u1', username: 'me' } }));
    await expect(getUser('vca_x')).resolves.toEqual({ id: 'u1', username: 'me' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.vercel.com/v2/user');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer vca_x' });
  });

  it('surfaces defaultTeamId — the CLI-login team fallback when the store has no currentTeam', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { user: { id: 'u1', username: 'me', defaultTeamId: 'team_abc' } }),
    );
    await expect(getUser('vca_x')).resolves.toMatchObject({ defaultTeamId: 'team_abc' });
  });

  it('throws with the API message on failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { message: 'Not authorized' } }));
    await expect(getUser('vca_x')).rejects.toThrow(/403.*Not authorized/);
  });
});

describe('listProjects', () => {
  it('maps projects to id+name and scopes by team', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { projects: [{ id: 'prj_1', name: 'a' }, { id: 'prj_2', name: 'b' }] }),
    );
    await expect(listProjects('vca_x', 'team_1')).resolves.toEqual([
      { id: 'prj_1', name: 'a' },
      { id: 'prj_2', name: 'b' },
    ]);
    expect(fetchMock.mock.calls[0]![0]).toContain('teamId=team_1');
  });

  it('returns [] when the response has no projects', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await expect(listProjects('vca_x', 'team_1')).resolves.toEqual([]);
  });
});

describe('createProject', () => {
  it('POSTs the name and returns the new project', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'prj_new', name: 'agentbox' }));
    await expect(createProject('vca_x', 'team_1', 'agentbox')).resolves.toEqual({
      id: 'prj_new',
      name: 'agentbox',
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'agentbox' });
  });

  it('reuses the existing project on a 409 name collision', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { error: { message: 'name taken' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, { projects: [{ id: 'prj_existing', name: 'agentbox' }] }),
      );
    await expect(createProject('vca_x', 'team_1', 'agentbox')).resolves.toEqual({
      id: 'prj_existing',
      name: 'agentbox',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-409 error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'boom' } }));
    await expect(createProject('vca_x', 'team_1', 'agentbox')).rejects.toThrow(/500.*boom/);
  });
});

describe('git-backed deploy helpers', () => {
  it('getProject returns null on 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { message: 'not found' } }));
    await expect(getProject('vca_x', 'team_1', 'agentbox-control-plane')).resolves.toBeNull();
  });

  it('createGitProject connects the repo with rootDirectory + nextjs (v11)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'prj_cp', name: 'agentbox-control-plane' }));
    await createGitProject('vca_x', 'team_1', {
      name: 'agentbox-control-plane',
      repo: 'madarco/agentbox',
      rootDirectory: 'apps/control-plane',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v11/projects');
    expect(String(url)).toContain('teamId=team_1');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'agentbox-control-plane',
      framework: 'nextjs',
      rootDirectory: 'apps/control-plane',
      gitRepository: { type: 'github', repo: 'madarco/agentbox' },
    });
  });

  it('upsertProjectEnv posts an array with ?upsert=true and production target', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { created: [], failed: [] }));
    await upsertProjectEnv('vca_x', 'team_1', 'prj_cp', [
      { key: 'GITHUB_APP_ID', value: '42' },
      { key: 'AGENTBOX_RELAY_ADMIN_TOKEN', value: 'tok' },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v10/projects/prj_cp/env');
    expect(String(url)).toContain('upsert=true');
    const body = JSON.parse((init as RequestInit).body as string) as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({ key: 'GITHUB_APP_ID', type: 'encrypted', target: ['production'] });
  });

  it('createGitDeployment sends a production gitSource (org+repo+ref, no upload)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'dpl_1', url: 'x-abc.vercel.app' }));
    await expect(
      createGitDeployment('vca_x', 'team_1', {
        name: 'agentbox-control-plane',
        projectId: 'prj_cp',
        owner: 'madarco',
        repo: 'agentbox',
        ref: 'main',
      }),
    ).resolves.toEqual({ id: 'dpl_1', url: 'x-abc.vercel.app' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v13/deployments');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      project: 'prj_cp',
      target: 'production',
      gitSource: { type: 'github', org: 'madarco', repo: 'agentbox', ref: 'main' },
    });
    expect('files' in body).toBe(false); // gitSource must not be combined with files
  });

  it('getDeployment normalizes readyState/status + error fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { readyState: 'ERROR', errorMessage: 'nope', errorStep: 'build' }));
    await expect(getDeployment('vca_x', 'team_1', 'dpl_1')).resolves.toMatchObject({
      readyState: 'ERROR',
      errorMessage: 'nope',
      errorStep: 'build',
    });
  });

  it('getProductionAlias reads the project production alias', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: 'prj_cp', name: 'x', targets: { production: { alias: ['cp.example.app', 'other'] } } }),
    );
    await expect(getProductionAlias('vca_x', 'team_1', 'prj_cp')).resolves.toBe('cp.example.app');
  });
});
