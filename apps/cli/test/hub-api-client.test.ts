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

// `session: null`: the default detects the host agent session, which on a
// developer machine is whatever claude/codex session runs the suite.
const target = (fetchImpl: typeof fetch) => ({
  url: 'https://hub.example/',
  apiKey: 'KEY',
  fetchImpl,
  session: null,
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
        body: {
          ok: true,
          name: 'warm',
          kind: 'layered',
          ref: 'warm',
          provider: 'docker',
          dir: '/d',
        },
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
    expect(calls[0]!.url).toBe(
      'https://hub.example/api/v1/checkpoints?project=%2Fp&ref=warm&provider=docker',
    );
  });

  it('prunes: general (default) and cloud (with provider) bodies', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/prune': {
        status: 200,
        body: {
          kind: 'general',
          result: {
            removedRecords: [],
            removedContainers: [],
            removedVolumes: [],
            removedSnapshotDirs: [],
            removedBoxDirs: [],
            removedCheckpointImages: [],
            dryRun: true,
          },
          projectConfigs: [],
        },
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
      new HubApiClient(target(fetchImpl)).streamBoxLog(
        'b1',
        { service: 'web', tail: 10 },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('createBox POSTs the widened body to /boxes and returns the jobId', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/boxes': { status: 202, body: { jobId: 'job-1' } },
    });
    const res = await new HubApiClient(target(fetchImpl)).createBox({
      projectId: 'p',
      agent: 'none',
      foreground: true,
      opts: { image: 'agentbox/box:dev', carry: [{ absSrc: '/x' }] },
    });
    expect(res.jobId).toBe('job-1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes');
    expect(calls[0]!.body).toMatchObject({ projectId: 'p', agent: 'none', foreground: true });
  });

  it('lists jobs and unwraps the envelope', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/jobs': {
        status: 200,
        body: { jobs: [{ id: 'j1', status: 'running', provider: 'docker' }] },
      },
    });
    const jobs = await new HubApiClient(target(fetchImpl)).listJobs();
    expect(jobs).toEqual([{ id: 'j1', status: 'running', provider: 'docker' }]);
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/jobs');
  });

  it('submitLoginCode POSTs the pasted code to the job login-code route', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/jobs/j1/login-code': { status: 200, body: { ok: true } },
    });
    await new HubApiClient(target(fetchImpl)).submitLoginCode('j1', 'ABC-123');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/jobs/j1/login-code');
    expect(calls[0]!.body).toEqual({ code: 'ABC-123' });
  });
});

describe('HubApiClient workspaces', () => {
  it('lists workspaces and unwraps the envelope', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/workspaces': { status: 200, body: { workspaces: [{ id: 'w1', name: 'code' }] } },
    });
    const out = await new HubApiClient(target(fetchImpl)).listWorkspaces();
    // A hub one release older serves the folder-keyed record and still reports
    // `apiVersion: v1`, so the collections are filled in HERE rather than left to
    // throw in whichever caller indexes them first.
    expect(out).toEqual([{ id: 'w1', name: 'code', projects: [], hosts: {}, projectIds: [] }]);
    expect(calls[0]?.url).toBe('https://hub.example/api/v1/workspaces');
  });

  it('fills the collections in on every workspace it returns', async () => {
    const { fetchImpl } = stub({
      'GET /api/v1/workspaces/w1': { status: 200, body: { id: 'w1', name: 'old' } },
      'POST /api/v1/managers/detect': {
        status: 200,
        body: { manager: { id: 'm1' }, workspace: { id: 'w1', name: 'old' } },
      },
    });
    const client = new HubApiClient(target(fetchImpl));
    const one = await client.getWorkspace('w1');
    expect(one.hosts).toEqual({});
    expect(one.projects).toEqual([]);
    const detected = await client.detectManager({
      agent: 'claude',
      sessionId: 's',
      cwd: '/x',
      host: 'laptop',
    });
    expect(detected.workspace.hosts).toEqual({});
    expect(detected.manager.id).toBe('m1');
  });

  it("posts the caller's own scan, host included", async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/workspaces': { status: 200, body: { id: 'w1' } },
    });
    const body = {
      host: 'laptop',
      root: '/Users/me/code',
      projects: [{ path: '/Users/me/code/app', name: 'app', repoUrl: 'git@github.com:me/app.git' }],
    };
    await new HubApiClient(target(fetchImpl)).addWorkspace(body);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual(body);
  });

  it('encodes the workspace id into every sub-path', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/workspaces/a%20b/tasks': { status: 200, body: { tasks: [] } },
    });
    await new HubApiClient(target(fetchImpl)).listTasks('a b');
    expect(calls[0]?.url).toBe('https://hub.example/api/v1/workspaces/a%20b/tasks');
  });

  it('sends task filters as query parameters', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/workspaces/w1/tasks': { status: 200, body: { tasks: [] } },
      'GET /api/v1/tasks': { status: 200, body: { tasks: [] } },
    });
    const client = new HubApiClient(target(fetchImpl));
    await client.listTasks('w1', { status: 'todo', boxId: 'b1' });
    expect(calls[0]?.url).toContain('status=todo');
    expect(calls[0]?.url).toContain('boxId=b1');
    await client.listAllTasks({ workspaceId: 'w1' });
    expect(calls[1]?.url).toBe('https://hub.example/api/v1/tasks?workspaceId=w1');
  });

  it('assigns tasks with the target folded into the body', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/workspaces/w1/tasks/assign': { status: 200, body: { tasks: [] } },
    });
    await new HubApiClient(target(fetchImpl)).assignTasks('w1', ['T-1', 'T-2'], { boxJobId: 'j1' });
    expect(calls[0]?.body).toEqual({ ids: ['T-1', 'T-2'], boxJobId: 'j1' });
  });

  it('drives the manager routes', async () => {
    const { fetchImpl, calls } = stub({
      'POST /api/v1/managers/detect': {
        status: 201,
        body: { manager: { id: 'm1' }, workspace: {} },
      },
      'GET /api/v1/managers': { status: 200, body: { managers: [] } },
      'POST /api/v1/workspaces/w1/managers/start': { status: 200, body: { status: 'running' } },
      'POST /api/v1/managers/m1/resume': { status: 200, body: { status: 'running' } },
      'POST /api/v1/managers/m1/stop': { status: 200, body: { status: 'stopped' } },
      'DELETE /api/v1/managers/m1': { status: 200, body: { ok: true } },
      'GET /api/v1/workspaces/w1/managers/sessions': {
        status: 200,
        body: { agent: 'claude', supported: true, sessions: [] },
      },
    });
    const client = new HubApiClient(target(fetchImpl));
    const detected = await client.detectManager({ agent: 'claude', sessionId: 's1', cwd: '/w' });
    expect(detected.manager.id).toBe('m1');
    expect(calls[0]?.body).toEqual({ agent: 'claude', sessionId: 's1', cwd: '/w' });
    await client.listManagers({ workspaceId: 'w1', status: 'running' });
    expect(calls[1]?.url).toBe('https://hub.example/api/v1/managers?workspaceId=w1&status=running');
    await client.startManager('w1', { agent: 'claude', sessionId: 's1' });
    expect(calls[2]?.body).toEqual({ agent: 'claude', sessionId: 's1' });
    await client.resumeManager('m1');
    await client.stopManager('m1');
    await client.removeManager('m1');
    await client.listManagerSessions('w1', 'codex');
    expect(calls[6]?.url).toBe(
      'https://hub.example/api/v1/workspaces/w1/managers/sessions?agent=codex',
    );
  });

  it('maps a missing workspace to a not_found HubApiError', async () => {
    const { fetchImpl } = stub({
      'GET /api/v1/workspaces/gone': {
        status: 404,
        body: { error: { code: 'not_found', message: 'unknown workspace gone' } },
      },
    });
    await expect(new HubApiClient(target(fetchImpl)).getWorkspace('gone')).rejects.toThrow(
      HubApiError,
    );
  });
});
