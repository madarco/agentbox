import { describe, expect, it } from 'vitest';
import { HubApiClient, HubApiError } from '../src/control-plane/hub-api-client.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fetch stub that records calls and replies from a per-path table. */
function stub(replies: Record<string, { status: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({
      url: u,
      method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const key = `${method} ${new URL(u).pathname}`;
    const reply = replies[key] ?? {
      status: 404,
      body: { error: { code: 'not_found', message: 'no route' } },
    };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const target = (fetchImpl: typeof fetch) => ({
  url: 'https://hub.example/',
  apiKey: 'KEY',
  fetchImpl,
});

describe('HubApiClient', () => {
  it('lists boxes and unwraps the envelope', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/boxes': {
        status: 200,
        body: { boxes: [{ id: 'b1', provider: 'e2b', status: 'running', branch: 'x', task: 't' }] },
      },
    });
    const boxes = await new HubApiClient(target(fetchImpl)).listBoxes();
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.id).toBe('b1');
    // Bearer auth + the /api/v1 base URL (trailing slash on the target trimmed).
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes');
    expect(calls[0]!.headers.Authorization).toBe('Bearer KEY');
  });

  it('posts a lifecycle action to the right path', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/boxes/b1/pause': { status: 200, body: { ok: true } },
    });
    await new HubApiClient(target(fetchImpl)).lifecycle('b1', 'pause');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/pause');
  });

  it('destroy posts to /destroy and carries keepSnapshot on the body', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/boxes/b1/destroy': { status: 200, body: { ok: true } },
    });
    const client = new HubApiClient(target(fetchImpl));
    await client.destroy('b1');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/destroy');
    expect(calls[0]!.body).toEqual({});
    await client.destroy('b1', { keepSnapshot: true });
    expect(calls[1]!.body).toEqual({ keepSnapshot: true });
  });

  it('answers an approval with the answer body', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/approvals/p1/answer': { status: 200, body: { ok: true } },
    });
    await new HubApiClient(target(fetchImpl)).answerApproval('p1', 'y');
    expect(calls[0]!.body).toEqual({ answer: 'y' });
  });

  it('throws a typed HubApiError carrying the envelope code + status', async () => {
    const { fetchImpl } = stub({
      'POST /api/v1/boxes/gone/pause': {
        status: 404,
        body: { error: { code: 'not_found', message: 'box not found: gone' } },
      },
    });
    const client = new HubApiClient(target(fetchImpl));
    await expect(client.lifecycle('gone', 'pause')).rejects.toMatchObject({
      name: 'HubApiError',
      code: 'not_found',
      status: 404,
    });
    await expect(client.lifecycle('gone', 'pause')).rejects.toBeInstanceOf(HubApiError);
  });

  it('treats 204 as a successful empty response', async () => {
    const { fetchImpl } = stub({ 'POST /api/v1/boxes/b1/stop': { status: 204 } });
    await expect(
      new HubApiClient(target(fetchImpl)).lifecycle('b1', 'stop'),
    ).resolves.toBeUndefined();
  });

  it('gets a box services snapshot', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/boxes/b1/services': {
        status: 200,
        body: {
          source: 'persisted',
          services: [
            {
              name: 'web',
              state: 'running',
              pid: null,
              restarts: 0,
              lastExitCode: null,
              blockedOn: [],
              command: '',
            },
          ],
          tasks: [],
          ports: [{ port: 3000, service: 'web' }],
        },
      },
    });
    const svc = await new HubApiClient(target(fetchImpl)).getServices('b1');
    expect(svc.source).toBe('persisted');
    expect(svc.services[0]!.name).toBe('web');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/services');
  });

  it('restarts one service by name, or all with an empty body', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/boxes/b1/services/restart': { status: 200, body: { ok: true } },
    });
    const client = new HubApiClient(target(fetchImpl));
    await client.restartService('b1', 'web');
    expect(calls[0]!.body).toEqual({ name: 'web' });
    await client.restartService('b1');
    expect(calls[1]!.body).toEqual({});
    expect(calls[1]!.url).toBe('https://hub.example/api/v1/boxes/b1/services/restart');
  });

  it('renames a box (empty string clears the label)', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/boxes/b1/rename': { status: 200, body: { ok: true } },
    });
    const client = new HubApiClient(target(fetchImpl));
    await client.rename('b1', 'my box');
    expect(calls[0]!.body).toEqual({ displayName: 'my box' });
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/rename');
    await client.rename('b1', '');
    expect(calls[1]!.body).toEqual({ displayName: '' });
  });

  it('reads the health probe (apiVersion + version)', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/health': {
        status: 200,
        body: { ok: true, apiVersion: 'v1', version: '0.28.0', profile: 'localhost' },
      },
    });
    const h = await new HubApiClient(target(fetchImpl)).health();
    expect(h.apiVersion).toBe('v1');
    expect(h.version).toBe('0.28.0');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/health');
  });

  // ── Step 9: checkpoint / prune / agent / logs ──

  it('creates a checkpoint on the box route with the capture options', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/boxes/b1/checkpoint': {
        status: 200,
        body: { ok: true, name: 'warm', kind: 'layered', ref: 'warm', provider: 'docker', dir: '/d' },
      },
    });
    const info = await new HubApiClient(target(fetchImpl)).createCheckpoint('b1', {
      name: 'warm',
      setDefault: true,
    });
    expect(info.ref).toBe('warm');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/checkpoint');
    expect(calls[0]!.body).toEqual({ name: 'warm', setDefault: true });
  });

  it('lists checkpoints scoped by project and globally', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/checkpoints': { status: 200, body: { projects: [] } },
    });
    const client = new HubApiClient(target(fetchImpl));
    await client.listCheckpoints({ project: '/home/me/app' });
    await client.listCheckpoints({ global: true });
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/checkpoints?project=%2Fhome%2Fme%2Fapp');
    expect(calls[1]!.url).toBe('https://hub.example/api/v1/checkpoints?global=1');
  });

  it('deletes a checkpoint via DELETE with project/ref/provider query', async () => {
    const { fetchImpl, calls } = stub({
      'DELETE /api/v1/checkpoints': {
        status: 200,
        body: { ok: true, removed: ['docker'], clearedKeys: [], warnedKeys: [] },
      },
    });
    const res = await new HubApiClient(target(fetchImpl)).deleteCheckpoint({
      project: '/p',
      ref: 'warm',
      provider: 'docker',
    });
    expect(res.removed).toEqual(['docker']);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/checkpoints?project=%2Fp&ref=warm&provider=docker');
  });

  it('prunes: general (default) and cloud (with provider) bodies', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/prune': {
        status: 200,
        body: { kind: 'general', result: { removedRecords: [], removedContainers: [], removedVolumes: [], removedSnapshotDirs: [], removedBoxDirs: [], removedCheckpointImages: [], dryRun: true }, projectConfigs: [] },
      },
    });
    const client = new HubApiClient(target(fetchImpl));
    await client.prune({ all: true, dryRun: true });
    await client.prune({ provider: 'e2b', dryRun: true });
    expect(calls[0]!.body).toEqual({ all: true, dryRun: true });
    expect(calls[1]!.body).toEqual({ provider: 'e2b', dryRun: true });
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/prune');
  });

  it('reads the agent state snapshot', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/boxes/b1/agent': { status: 200, body: { claude: { state: 'idle' } } },
    });
    const res = await new HubApiClient(target(fetchImpl)).getAgentState('b1');
    expect(res.claude).toEqual({ state: 'idle' });
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/agent');
  });

  it('fetches a non-follow log snapshot with tail/service/daemon query', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/boxes/b1/logs': { status: 200, body: { output: 'line1\nline2\n' } },
    });
    const client = new HubApiClient(target(fetchImpl));
    const r = await client.getBoxLogs('b1', { service: 'web', tail: 50 });
    expect(r.output).toBe('line1\nline2\n');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/logs?tail=50&service=web');
    await client.getBoxLogs('b1', { tail: 20, daemon: true });
    expect(calls[1]!.url).toBe('https://hub.example/api/v1/boxes/b1/logs?tail=20&daemon=1');
  });

  it('surfaces a not_found on the log stream as a HubApiError (so withOwningHub can retry)', async () => {
    const { fetchImpl } = stub({
      'GET /api/v1/boxes/b1/logs': {
        status: 404,
        body: { error: { code: 'not_found', message: 'box not found: b1' } },
      },
    });
    await expect(
      new HubApiClient(target(fetchImpl)).streamBoxLog('b1', { service: 'web', tail: 10 }, () => {}),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});
