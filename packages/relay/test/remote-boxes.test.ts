import { afterAll, describe, expect, it } from 'vitest';
import { handleRemoteBoxesRequest } from '../src/remote-boxes.js';
import { SqliteStore } from '../src/store/sqlite-store.js';

const ADMIN = 'admin-secret';
const open: SqliteStore[] = [];
function store(): SqliteStore {
  const s = new SqliteStore({ path: ':memory:' });
  open.push(s);
  return s;
}
afterAll(async () => {
  await Promise.all(open.map((s) => s.close()));
});

function req(over: Partial<Parameters<typeof handleRemoteBoxesRequest>[0]>) {
  return { method: 'GET', path: '/remote/boxes', bearer: ADMIN, bodyText: '', ...over };
}

describe('handleRemoteBoxesRequest', () => {
  it('returns null for non-remote paths (router falls through)', async () => {
    const res = await handleRemoteBoxesRequest(req({ path: '/events' }), { store: store(), adminToken: ADMIN });
    expect(res).toBeNull();
  });

  it('fail-closes 503 when the admin token is unset', async () => {
    const res = await handleRemoteBoxesRequest(req({ bearer: '' }), { store: store(), adminToken: '' });
    expect(res?.status).toBe(503);
  });

  it('401s a wrong bearer', async () => {
    const res = await handleRemoteBoxesRequest(req({ bearer: 'nope' }), { store: store(), adminToken: ADMIN });
    expect(res?.status).toBe(401);
  });

  it('400s a malformed enqueue body', async () => {
    const res = await handleRemoteBoxesRequest(
      req({ method: 'POST', bodyText: JSON.stringify({ provider: 'e2b' }) }),
      { store: store(), adminToken: ADMIN },
    );
    expect(res?.status).toBe(400);
  });

  it('enqueues (202) and round-trips via GET /remote/boxes/:id', async () => {
    const s = store();
    const enq = await handleRemoteBoxesRequest(
      req({ method: 'POST', bodyText: JSON.stringify({ repoUrl: 'https://x/r.git', provider: 'e2b', branch: 'main' }) }),
      { store: s, adminToken: ADMIN },
    );
    expect(enq?.status).toBe(202);
    const jobId = (enq?.body as { jobId: string }).jobId;
    expect(jobId).toBeTruthy();

    const get = await handleRemoteBoxesRequest(req({ path: `/remote/boxes/${jobId}` }), { store: s, adminToken: ADMIN });
    expect(get?.status).toBe(200);
    expect((get?.body as { request: { provider: string } }).request.provider).toBe('e2b');
    expect((get?.body as { status: string }).status).toBe('queued');
  });

  it('404s an unknown job id', async () => {
    const res = await handleRemoteBoxesRequest(req({ path: '/remote/boxes/missing' }), { store: store(), adminToken: ADMIN });
    expect(res?.status).toBe(404);
  });

  it('rejects a provider outside the allowlist', async () => {
    const res = await handleRemoteBoxesRequest(
      req({ method: 'POST', bodyText: JSON.stringify({ repoUrl: 'https://x/r.git', provider: 'hetzner' }) }),
      { store: store(), adminToken: ADMIN, createProviders: ['e2b', 'vercel'] },
    );
    expect(res?.status).toBe(400);
  });

  it('501s when the store has no create-job queue', async () => {
    // A store without the optional queue methods (e.g. a federated RemoteStore).
    const bare = { enqueueCreateJob: undefined } as unknown as Parameters<
      typeof handleRemoteBoxesRequest
    >[1]['store'];
    const res = await handleRemoteBoxesRequest(
      req({ method: 'POST', bodyText: JSON.stringify({ repoUrl: 'https://x/r.git', provider: 'e2b' }) }),
      { store: bare, adminToken: ADMIN },
    );
    expect(res?.status).toBe(501);
  });
});
