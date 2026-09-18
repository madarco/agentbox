import { describe, expect, it } from 'vitest';
import { remoteTimelineSink } from '../src/workspaces/timeline-sink.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(replies: (call: Call) => { status: number; body?: unknown } | Promise<never>): {
  impl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    };
    calls.push(call);
    const reply = await replies(call);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const TARGET = { url: 'https://hub.example/', apiKey: 'k1' };

const WORKSPACES = {
  workspaces: [
    {
      id: 'ws1',
      projects: [{ repoUrl: 'git@github.com:acme/storefront.git' }],
      hosts: { pc: { root: '/home/me/work' } },
    },
  ],
};

describe('the remote timeline sink', () => {
  it('posts an event to the control box and returns what it appended', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 201,
      body: { event: { id: 'e1', at: 'now', type: 'box.ready', actor: 'hub' } },
    }));
    const sink = remoteTimelineSink(TARGET, { fetchImpl: impl });
    const event = await sink.record('ws1', { type: 'box.ready', actor: 'hub', key: 'job:1:ready' });
    expect(event?.id).toBe('e1');
    expect(calls[0]).toMatchObject({
      url: 'https://hub.example/api/v1/workspaces/ws1/timeline/events',
      method: 'POST',
      headers: { Authorization: 'Bearer k1' },
      body: { type: 'box.ready', actor: 'hub', key: 'job:1:ready' },
    });
  });

  it('reports nothing appended for a deduped key or an unknown workspace', async () => {
    const dedupe = fakeFetch(() => ({ status: 200, body: { deduped: true } }));
    expect(
      await remoteTimelineSink(TARGET, { fetchImpl: dedupe.impl }).record('ws1', {
        type: 'box.ready',
        actor: 'hub',
        key: 'job:1:ready',
      }),
    ).toBeNull();
    const missing = fakeFetch(() => ({ status: 404 }));
    const warnings: string[] = [];
    expect(
      await remoteTimelineSink(TARGET, {
        fetchImpl: missing.impl,
        warn: (m) => warnings.push(m),
      }).record('nope', { type: 'box.ready', actor: 'hub' }),
    ).toBeNull();
    // A workspace this hub does not have is not a reachability problem.
    expect(warnings).toEqual([]);
  });

  it('warns once when the control box cannot be reached, and never throws', async () => {
    const warnings: string[] = [];
    const sink = remoteTimelineSink(TARGET, {
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
      warn: (m) => warnings.push(m),
    });
    expect(await sink.record('ws1', { type: 'box.ready', actor: 'hub' })).toBeNull();
    expect(await sink.record('ws1', { type: 'box.failed', actor: 'hub' })).toBeNull();
    expect(await sink.workspaceFor({ originUrl: 'git@github.com:acme/storefront.git' })).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('https://hub.example');
  });

  it('joins a box to a workspace off the control box listing, and caches it', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: WORKSPACES }));
    let now = 1000;
    const sink = remoteTimelineSink(TARGET, { fetchImpl: impl, now: () => now });
    expect((await sink.workspaceFor({ originUrl: 'https://github.com/acme/storefront' }))?.id).toBe(
      'ws1',
    );
    // The folder key names a path on ANOTHER machine, so it is matched verbatim.
    expect((await sink.workspaceFor({ host: 'pc', projectRoot: '/home/me/work/x' }))?.id).toBe(
      'ws1',
    );
    expect(calls).toHaveLength(1);
    now += 30_001;
    expect((await sink.workspaceFor({ originUrl: 'https://github.com/acme/storefront' }))?.id).toBe(
      'ws1',
    );
    expect(calls).toHaveLength(2);
  });

  it('answers nothing when no workspace lists the repo', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: WORKSPACES }));
    const sink = remoteTimelineSink(TARGET, { fetchImpl: impl });
    expect(await sink.workspaceFor({ originUrl: 'git@github.com:acme/other.git' })).toBeNull();
  });
});
