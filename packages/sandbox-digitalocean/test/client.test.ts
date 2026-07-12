/**
 * Unit tests for the hand-rolled DigitalOcean REST client. We inject a mock
 * `fetch` so nothing hits the network — the goal is to lock down request
 * shaping (auth header, paths), response unwrapping, action/pagination
 * handling, and error mapping.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DigitalOceanApiError, makeDigitalOceanClient } from '../src/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return makeDigitalOceanClient({ token: 'do_test_token', fetchImpl });
}

describe('makeDigitalOceanClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('sends a Bearer auth header and hits the v2 base URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { account: { uuid: 'u1', email: 'a@b.c', status: 'active', droplet_limit: 25 } }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const acct = await client.getAccount();
    expect(acct.email).toBe('a@b.c');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.digitalocean.com/v2/account');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer do_test_token' });
  });

  it('throws when the token is empty', () => {
    expect(() => makeDigitalOceanClient({ token: '   ', fetchImpl: fetchMock as unknown as typeof fetch })).toThrow(
      /DIGITALOCEAN_TOKEN is empty/,
    );
  });

  it('parses createDroplet and extracts the create-action id', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(202, {
        droplet: { id: 123, name: 'agentbox-x', status: 'new', created_at: 't', networks: { v4: [], v6: [] }, image: null, size_slug: 's-2vcpu-4gb', region: { slug: 'nyc3', name: 'NYC3' }, tags: ['agentbox'] },
        links: { actions: [{ id: 999, rel: 'create', href: 'x' }] },
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const { droplet, actionId } = await client.createDroplet({ name: 'agentbox-x', region: 'nyc3', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64' });
    expect(droplet.id).toBe(123);
    expect(actionId).toBe(999);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('POST');
  });

  it('returns null from getDroplet on 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { id: 'not_found', message: 'gone' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.getDroplet(404)).resolves.toBeNull();
  });

  it('maps a 4xx error body { id, message } into DigitalOceanApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { id: 'unauthorized', message: 'bad token', request_id: 'req-1' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.getAccount()).rejects.toMatchObject({
      name: 'DigitalOceanApiError',
      statusCode: 401,
      code: 'unauthorized',
      requestId: 'req-1',
    });
    await expect(client.getAccount()).rejects.toBeInstanceOf(DigitalOceanApiError);
  });

  it('follows links.pages.next when paginating listDroplets', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          droplets: [{ id: 1, name: 'a', status: 'active', created_at: 't', networks: { v4: [], v6: [] }, image: null, size_slug: 's', region: null, tags: [] }],
          links: { pages: { next: 'https://api.digitalocean.com/v2/droplets?tag_name=agentbox&per_page=200&page=2' } },
          meta: { total: 2 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          droplets: [{ id: 2, name: 'b', status: 'off', created_at: 't', networks: { v4: [], v6: [] }, image: null, size_slug: 's', region: null, tags: [] }],
          links: {},
          meta: { total: 2 },
        }),
      );
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const droplets = await client.listDroplets({ tag_name: 'agentbox' });
    expect(droplets.map((d) => d.id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads the droplet action id from snapshotDroplet', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { action: { id: 555, status: 'in-progress', type: 'snapshot', resource_id: 123, resource_type: 'droplet' } }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const action = await client.snapshotDroplet(123, 'agentbox-base-x');
    expect(action.id).toBe(555);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.digitalocean.com/v2/droplets/123/actions');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ type: 'snapshot', name: 'agentbox-base-x' });
  });

  it('treats a 204 as a successful empty delete', async () => {
    fetchMock.mockResolvedValue(jsonResponse(204, null));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.deleteFirewall('fw-uuid')).resolves.toBeUndefined();
  });

  it('createTag POSTs the name and swallows a 422 already-exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { tag: { name: 'agentbox-box-x' } }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.createTag('agentbox-box-x')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.digitalocean.com/v2/tags');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'agentbox-box-x' });
    // A duplicate tag returns 422 — must resolve, not throw.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { id: 'unprocessable_entity', message: 'Tag already exists' }),
    );
    await expect(client.createTag('agentbox-box-x')).resolves.toBeUndefined();
  });

  it('deleteTag DELETEs the encoded name and is idempotent on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204, null));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.deleteTag('agentbox-box-x')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.digitalocean.com/v2/tags/agentbox-box-x');
    // 404 (already gone) is mapped to null by `req`, so delete resolves.
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { id: 'not_found', message: 'gone' }));
    await expect(client.deleteTag('agentbox-box-x')).resolves.toBeUndefined();
  });
});

describe('projects', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('paginates listProjects', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          projects: [{ id: 'p1', name: 'first-project', is_default: true }],
          links: { pages: { next: 'https://api.digitalocean.com/v2/projects?page=2' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { projects: [{ id: 'p2', name: 'client-x', is_default: false }] }),
      );

    const projects = await makeClient(fetchMock as unknown as typeof fetch).listProjects();
    expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('returns null when there is no default project (404)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }));
    const p = await makeClient(fetchMock as unknown as typeof fetch).getDefaultProject();
    expect(p).toBeNull();
  });

  // The URN shape is the whole contract of the assign call — DigitalOcean has no
  // project field on droplet-create, so this request is the only way a box ever
  // reaches its project.
  it('assigns a droplet by URN', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { resources: [] }));
    await makeClient(fetchMock as unknown as typeof fetch).assignProjectResources('p2', [
      'do:droplet:123',
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.digitalocean.com/v2/projects/p2/resources');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ resources: ['do:droplet:123'] });
  });
});
