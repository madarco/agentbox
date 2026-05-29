import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, getUser, listProjects } from '../src/vercel-rest.js';

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
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.vercel.com/v2/user');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer vca_x' });
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
    expect(fetchMock.mock.calls[0][0]).toContain('teamId=team_1');
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
    const init = fetchMock.mock.calls[0][1] as RequestInit;
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
