import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';

interface FetchResult {
  status: number;
  body: unknown;
  text: string;
}

async function fetchJson(
  handle: RelayServerHandle,
  method: string,
  path: string,
  init: { token?: string; body?: unknown } = {},
): Promise<FetchResult> {
  const port = (handle.server.address() as AddressInfo).port;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text };
}

async function register(
  handle: RelayServerHandle,
  boxId: string,
  token: string,
  name: string,
): Promise<void> {
  const r = await fetchJson(handle, 'POST', '/admin/register-box', {
    body: { boxId, token, name },
  });
  expect(r.status).toBe(204);
}

describe('relay server', () => {
  let handle: RelayServerHandle;
  let prevPromptEnv: string | undefined;

  beforeEach(async () => {
    // Auto-accept prompts in this suite — the existing /rpc git.push test
    // wants to exercise the worktree-resolution failure, which lives behind
    // the new askPrompt gate. Tests that actually want to test the prompt
    // flow are in the next describe block and clear this.
    prevPromptEnv = process.env.AGENTBOX_PROMPT;
    process.env.AGENTBOX_PROMPT = 'off';
    // port 0 = ephemeral; binding 127.0.0.1 to avoid firewall prompts on macOS.
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
    if (prevPromptEnv === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPromptEnv;
  });

  it('healthz returns ok', async () => {
    const r = await fetchJson(handle, 'GET', '/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
  });

  it('rejects /events without a bearer token', async () => {
    const r = await fetchJson(handle, 'POST', '/events', { body: { type: 'x' } });
    expect(r.status).toBe(401);
  });

  it('rejects /events with an unknown token', async () => {
    const r = await fetchJson(handle, 'POST', '/events', {
      token: 'nope',
      body: { type: 'x' },
    });
    expect(r.status).toBe(401);
  });

  it('accepts /events from a registered box and appends to the ring buffer', async () => {
    await register(handle, 'b1', 't1', 'box-one');
    const r = await fetchJson(handle, 'POST', '/events', {
      token: 't1',
      body: { type: 'service-state', payload: { service: 'web', state: 'crashed' } },
    });
    expect(r.status).toBe(202);
    expect(handle.events.size()).toBe(1);
    const all = handle.events.all();
    expect(all[0]).toMatchObject({
      boxId: 'b1',
      type: 'service-state',
      payload: { service: 'web', state: 'crashed' },
    });
  });

  it('/admin/events filters by box and since', async () => {
    await register(handle, 'a', 'ta', 'a-name');
    await register(handle, 'b', 'tb', 'b-name');
    await fetchJson(handle, 'POST', '/events', { token: 'ta', body: { type: '1' } });
    await fetchJson(handle, 'POST', '/events', { token: 'tb', body: { type: '2' } });
    await fetchJson(handle, 'POST', '/events', { token: 'ta', body: { type: '3' } });

    const r = await fetchJson(handle, 'GET', '/admin/events?box=a');
    expect(r.status).toBe(200);
    const events = (r.body as { events: Array<{ type: string }> }).events;
    expect(events.map((e) => e.type)).toEqual(['1', '3']);

    const r2 = await fetchJson(handle, 'GET', '/admin/events?since=2');
    const events2 = (r2.body as { events: Array<{ id: number }> }).events;
    expect(events2.map((e) => e.id)).toEqual([3]);
  });

  it('/admin/forget-box drops the registration so token stops working', async () => {
    await register(handle, 'b', 't', 'name');
    const forget = await fetchJson(handle, 'POST', '/admin/forget-box', { body: { boxId: 'b' } });
    expect(forget.status).toBe(204);

    const post = await fetchJson(handle, 'POST', '/events', { token: 't', body: { type: 'x' } });
    expect(post.status).toBe(401);
  });

  it('/rpc returns 501 for unknown methods', async () => {
    await register(handle, 'b', 't', 'name');
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't',
      body: { method: 'something.unhandled' },
    });
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ method: 'something.unhandled' });
  });

  it('/rpc git.push returns a structured error when no worktree is registered', async () => {
    await register(handle, 'b', 't', 'name');
    const r = await fetchJson(handle, 'POST', '/rpc', {
      token: 't',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });
    // exitCode != 0 → 500 plus a {exitCode, stdout, stderr} envelope.
    expect(r.status).toBe(500);
    const body = r.body as { exitCode: number; stdout: string; stderr: string };
    expect(body.exitCode).toBe(64);
    expect(body.stderr).toMatch(/no worktree registered/);
  });

  it('/admin/registry returns boxes with tokens redacted', async () => {
    await register(handle, 'b', 'super-secret', 'one');
    const r = await fetchJson(handle, 'GET', '/admin/registry');
    expect(r.status).toBe(200);
    const body = r.body as { boxes: Array<Record<string, unknown>> };
    expect(body.boxes).toHaveLength(1);
    expect(body.boxes[0]).not.toHaveProperty('token');
    expect(body.boxes[0]).toMatchObject({ boxId: 'b', name: 'one' });
  });

  it('rejects malformed event bodies', async () => {
    await register(handle, 'b', 't', 'name');
    const r = await fetchJson(handle, 'POST', '/events', { token: 't', body: { payload: 1 } });
    expect(r.status).toBe(400);
  });

  it('rejects /admin/register-box without required fields', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/register-box', { body: { boxId: 'b' } });
    expect(r.status).toBe(400);
  });

  it('persists registered projectIndex and uses it in /admin/registry', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/register-box', {
      body: { boxId: 'idx-box', token: 'idx-tok', name: 'idx-name', projectIndex: 7 },
    });
    expect(r.status).toBe(204);
    const list = await fetchJson(handle, 'GET', '/admin/registry');
    expect(list.status).toBe(200);
    const body = list.body as { boxes: Array<{ boxId: string; projectIndex?: number }> };
    const entry = body.boxes.find((b) => b.boxId === 'idx-box');
    expect(entry?.projectIndex).toBe(7);
  });

  it('writes box-status into <id>-<n>-<mnemonic>/status.json when projectIndex is set', async () => {
    // Re-home $HOME so the status-store writes under a tmp dir and doesn't
    // pollute the user's ~/.agentbox during tests.
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'relay-status-'));
    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      await fetchJson(handle, 'POST', '/admin/register-box', {
        body: { boxId: 'pid42', token: 'tk', name: 'My-Box', projectIndex: 42 },
      });
      const post = await fetchJson(handle, 'POST', '/events', {
        token: 'tk',
        body: {
          type: 'box-status',
          payload: { schema: 1, boxId: 'pid42', services: [], tasks: [] },
        },
      });
      expect(post.status).toBe(202);
      // `My-Box` sanitizes to `my_box`; segment is `<id>-<n>-<mnemonic>`.
      const target = join(home, '.agentbox', 'boxes', 'pid42-42-my_box', 'status.json');
      const text = await readFile(target, 'utf8');
      const json = JSON.parse(text) as { boxId: string };
      expect(json.boxId).toBe('pid42');
    } finally {
      process.env['HOME'] = originalHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

/**
 * The host-action prompt flow: a /rpc that touches host state (git.push,
 * cp.*, download.*) waits for a prompt-ask SSE event to be answered by a
 * subscribed host wrapper. The relay's `askPrompt` blocks indefinitely on
 * its Promise — these tests verify the answer + denial paths end-to-end
 * without leaving the test runner hung.
 */
describe('relay prompt flow', () => {
  let handle: RelayServerHandle;

  beforeEach(async () => {
    // Explicit: prompts ARE active (no AGENTBOX_PROMPT=off here).
    delete process.env.AGENTBOX_PROMPT;
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('denial via /admin/prompts/answer short-circuits git.push with exit 10', async () => {
    await register(handle, 'b1', 't1', 'box-one');

    // Kick off the /rpc — it'll hang waiting for an answer. We drive the
    // answer flow concurrently and await both.
    const rpcPromise = fetchJson(handle, 'POST', '/rpc', {
      token: 't1',
      body: { method: 'git.push', params: { path: '/workspace' } },
    });

    // Wait for the pending prompt to land in the relay's map. The /rpc
    // handler adds it synchronously after authBox, but the await chain
    // means we need to yield. Polling the in-memory map is cheap.
    let pendingId: string | null = null;
    for (let i = 0; i < 50 && pendingId === null; i++) {
      const list = handle.prompts.forBox('b1');
      if (list.length > 0) pendingId = list[0]!.id;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(pendingId).not.toBeNull();

    const answer = await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: pendingId, answer: 'n' },
    });
    expect(answer.status).toBe(204);

    const rpc = await rpcPromise;
    expect(rpc.status).toBe(500);
    const body = rpc.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(10);
    expect(body.stderr).toMatch(/denied by user/);
  });

  it('answer with unknown id returns 404', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: 'no-such-id', answer: 'y' },
    });
    expect(r.status).toBe(404);
  });

  it('answer with malformed body returns 400', async () => {
    const r = await fetchJson(handle, 'POST', '/admin/prompts/answer', {
      body: { id: 'x', answer: 'maybe' },
    });
    expect(r.status).toBe(400);
  });

  it('/admin/prompts/stream requires a boxId query', async () => {
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/admin/prompts/stream`);
    expect(res.status).toBe(400);
  });
});
