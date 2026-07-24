import { describe, expect, it } from 'vitest';
import { HubApiClient, HubApiError } from '../src/control-plane/hub-api-client.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fetch stub that records calls and replies from a per-path table. */
function stub(
  replies: Record<string, { status: number; body?: unknown }>,
): { fetchImpl: typeof fetch; calls: Call[] } {
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
    const reply = replies[key] ?? { status: 404, body: { error: { code: 'not_found', message: 'no route' } } };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const target = (fetchImpl: typeof fetch) => ({ url: 'https://hub.example/', apiKey: 'KEY', fetchImpl });

describe('HubApiClient', () => {
  it('lists boxes and unwraps the envelope', async () => {
    const { fetchImpl, calls } = stub({
      'GET /api/v1/boxes': { status: 200, body: { boxes: [{ id: 'b1', provider: 'e2b', status: 'running', branch: 'x', task: 't' }] } },
    });
    const boxes = await new HubApiClient(target(fetchImpl)).listBoxes();
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.id).toBe('b1');
    // Bearer auth + the /api/v1 base URL (trailing slash on the target trimmed).
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes');
    expect(calls[0]!.headers.Authorization).toBe('Bearer KEY');
  });

  it('posts a lifecycle action to the right path', async () => {
    const { fetchImpl, calls } = stub({ 'POST /api/v1/boxes/b1/pause': { status: 200, body: { ok: true } } });
    await new HubApiClient(target(fetchImpl)).lifecycle('b1', 'pause');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/pause');
  });

  it('destroy maps to the destroy lifecycle action', async () => {
    const { fetchImpl, calls } = stub({ 'POST /api/v1/boxes/b1/destroy': { status: 200, body: { ok: true } } });
    await new HubApiClient(target(fetchImpl)).destroy('b1');
    expect(calls[0]!.url).toBe('https://hub.example/api/v1/boxes/b1/destroy');
  });

  it('answers an approval with the answer body', async () => {
    const { fetchImpl, calls } = stub({ 'POST /api/v1/approvals/p1/answer': { status: 200, body: { ok: true } } });
    await new HubApiClient(target(fetchImpl)).answerApproval('p1', 'y');
    expect(calls[0]!.body).toEqual({ answer: 'y' });
  });

  it('throws a typed HubApiError carrying the envelope code + status', async () => {
    const { fetchImpl } = stub({
      'POST /api/v1/boxes/gone/pause': { status: 404, body: { error: { code: 'not_found', message: 'box not found: gone' } } },
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
    await expect(new HubApiClient(target(fetchImpl)).lifecycle('b1', 'stop')).resolves.toBeUndefined();
  });
});
