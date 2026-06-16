import { describe, expect, it } from 'vitest';
import { handleRelayRequest, type ControlPlaneDeps } from '../src/core/handler.js';
import { GitHubAppLeaser, type GitHubAppConfig } from '../src/github-app.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { generateKeyPairSync } from 'node:crypto';

const ADMIN = 'admin-secret';

function deps(store: MemoryStore, leaser: ControlPlaneDeps['leaser'] = null): ControlPlaneDeps {
  return { store, leaser, adminToken: ADMIN };
}

function req(
  method: string,
  path: string,
  init: { bearer?: string; body?: unknown; query?: string } = {},
) {
  return {
    method,
    path,
    query: new URLSearchParams(init.query ?? ''),
    bearer: init.bearer ?? '',
    bodyText: init.body !== undefined ? JSON.stringify(init.body) : '',
  };
}

async function registerBox(store: MemoryStore, over: Record<string, unknown> = {}): Promise<void> {
  await store.registerBox({
    boxId: 'b1',
    token: 't1',
    name: 'box-one',
    registeredAt: new Date().toISOString(),
    originUrl: 'https://github.com/acme/widgets.git',
    ...over,
  });
}

// A leaser whose fetch is fully mocked — no network.
function fakeLeaser(): GitHubAppLeaser {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg: GitHubAppConfig = {
    appId: '1',
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/installation')) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    return new Response(
      JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3.6e6).toISOString() }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  return new GitHubAppLeaser(cfg, { fetchImpl });
}

describe('hosted control-plane handler', () => {
  it('healthz needs no auth', async () => {
    const r = await handleRelayRequest(req('GET', '/healthz'), deps(new MemoryStore()));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, controlPlane: true });
  });

  it('gates /admin on the admin bearer', async () => {
    const store = new MemoryStore();
    expect((await handleRelayRequest(req('GET', '/admin/registry'), deps(store))).status).toBe(401);
    const good = await handleRelayRequest(req('GET', '/admin/registry', { bearer: ADMIN }), deps(store));
    expect(good.status).toBe(200);
  });

  it('rejects host-local RPCs (no host on the plane)', async () => {
    const store = new MemoryStore();
    await registerBox(store);
    const r = await handleRelayRequest(
      req('POST', '/rpc', { bearer: 't1', body: { method: 'checkpoint.create' } }),
      deps(store),
    );
    expect(r.status).toBe(501);
    expect((r.body as { stderr: string }).stderr).toMatch(/not available on the hosted control plane/);
  });

  it('git.lease-token on an agentbox/* branch leases without approval', async () => {
    const store = new MemoryStore();
    await registerBox(store, {
      worktrees: [{ containerPath: '/workspace', hostMainRepo: '/r', branch: 'agentbox/box-one' }],
    });
    const r = await handleRelayRequest(
      req('POST', '/rpc', { bearer: 't1', body: { method: 'git.lease-token', params: { path: '/workspace' } } }),
      deps(store, fakeLeaser()),
    );
    expect(r.status).toBe(200);
    const lease = JSON.parse((r.body as { stdout: string }).stdout) as { token: string; remoteUrl: string };
    expect(lease.token).toBe('ghs_x');
    expect(lease.remoteUrl).toContain('x-access-token:ghs_x@github.com/acme/widgets');
  });

  it('git.lease-token on a non-agentbox branch parks for approval, then leases on poll', async () => {
    const store = new MemoryStore();
    await registerBox(store, {
      worktrees: [{ containerPath: '/workspace', hostMainRepo: '/r', branch: 'main' }],
    });
    const d = deps(store, fakeLeaser());
    const parked = await handleRelayRequest(
      req('POST', '/rpc', { bearer: 't1', body: { method: 'git.lease-token', params: { path: '/workspace' } } }),
      d,
    );
    expect(parked.status).toBe(202);
    const promptId = (parked.body as { promptId: string }).promptId;

    // Surfaces to an approver, who answers yes.
    const listed = await handleRelayRequest(req('GET', '/admin/prompts', { bearer: ADMIN, query: 'boxId=b1' }), d);
    expect((listed.body as { prompts: unknown[] }).prompts).toHaveLength(1);
    await handleRelayRequest(
      req('POST', '/admin/prompts/answer', { bearer: ADMIN, body: { id: promptId, answer: 'y' } }),
      d,
    );

    const done = await handleRelayRequest(req('GET', `/rpc/status/${promptId}`, { bearer: 't1' }), d);
    const result = (done.body as { status: string; result: { exitCode: number; stdout: string } });
    expect(result.status).toBe('done');
    expect(result.result.exitCode).toBe(0);
    expect(JSON.parse(result.result.stdout).token).toBe('ghs_x');
  });

  it('denied lease returns exit 10', async () => {
    const store = new MemoryStore();
    await registerBox(store, {
      worktrees: [{ containerPath: '/workspace', hostMainRepo: '/r', branch: 'main' }],
    });
    const d = deps(store, fakeLeaser());
    const parked = await handleRelayRequest(
      req('POST', '/rpc', { bearer: 't1', body: { method: 'git.lease-token', params: {} } }),
      d,
    );
    const promptId = (parked.body as { promptId: string }).promptId;
    await handleRelayRequest(
      req('POST', '/admin/prompts/answer', { bearer: ADMIN, body: { id: promptId, answer: 'n' } }),
      d,
    );
    const done = await handleRelayRequest(req('GET', `/rpc/status/${promptId}`, { bearer: 't1' }), d);
    expect((done.body as { result: { exitCode: number } }).result.exitCode).toBe(10);
  });

  it('register-box + events + status round-trip', async () => {
    const store = new MemoryStore();
    const d = deps(store);
    expect(
      (
        await handleRelayRequest(
          req('POST', '/admin/register-box', {
            bearer: ADMIN,
            body: { boxId: 'b1', token: 't1', name: 'box-one', kind: 'cloud' },
          }),
          d,
        )
      ).status,
    ).toBe(204);
    expect((await handleRelayRequest(req('POST', '/events', { bearer: 't1', body: { type: 'hello' } }), d)).status).toBe(202);
    const events = await handleRelayRequest(req('GET', '/admin/events', { bearer: ADMIN }), d);
    expect((events.body as { events: unknown[] }).events).toHaveLength(1);
  });

  it('reports App install status; 503 without a leaser', async () => {
    const store = new MemoryStore();
    const installed = await handleRelayRequest(
      req('GET', '/admin/app/repo-installed', { bearer: ADMIN, query: 'owner=acme&repo=widgets' }),
      deps(store, fakeLeaser()),
    );
    expect(installed.status).toBe(200);
    expect((installed.body as { installed: boolean }).installed).toBe(true);

    const noLeaser = await handleRelayRequest(
      req('GET', '/admin/app/repo-installed', { bearer: ADMIN, query: 'owner=acme&repo=widgets' }),
      deps(store),
    );
    expect(noLeaser.status).toBe(503);

    const noParams = await handleRelayRequest(
      req('GET', '/admin/app/repo-installed', { bearer: ADMIN }),
      deps(store, fakeLeaser()),
    );
    expect(noParams.status).toBe(400);
  });

  it('remote box creation enqueues a job (202); bad body is 400', async () => {
    const store = new MemoryStore();
    const bad = await handleRelayRequest(req('POST', '/remote/boxes', { bearer: ADMIN, body: {} }), deps(store));
    expect(bad.status).toBe(400);
    const good = await handleRelayRequest(
      req('POST', '/remote/boxes', {
        bearer: ADMIN,
        body: { repoUrl: 'https://github.com/acme/widgets.git', provider: 'e2b' },
      }),
      deps(store),
    );
    expect(good.status).toBe(202);
    expect(typeof (good.body as { jobId: string }).jobId).toBe('string');
  });
});
