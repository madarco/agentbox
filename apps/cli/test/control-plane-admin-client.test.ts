import { describe, expect, it } from 'vitest';
import { ControlPlaneAdminClient } from '../src/control-plane/admin-client.js';

/** A fake control box for the admin client's prompt + reap + list surfaces. */
function fakeControlBox(opts: {
  boxes?: Array<{ boxId: string; name: string }>;
  prompts?: Record<string, Array<{ id: string; message: string }>>; // boxId → pending
  answered?: Set<string>;
  reap?: (boxId: string) => { removed: boolean; custodyRemoved: number } | null;
}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname === '/admin/store') {
      const body = JSON.parse(init?.body ?? '{}') as { method: string };
      if (body.method === 'listBoxes') {
        return jsonRes({ result: (opts.boxes ?? []).map((b) => ({ registeredAt: '', ...b })) });
      }
      return jsonRes({ result: null });
    }
    if (u.pathname === '/admin/prompts') {
      const boxId = u.searchParams.get('boxId') ?? '';
      return jsonRes({ prompts: opts.prompts?.[boxId] ?? [] });
    }
    if (u.pathname === '/admin/prompts/answer') {
      const body = JSON.parse(init?.body ?? '{}') as { id: string };
      const known = opts.prompts ? Object.values(opts.prompts).flat().some((p) => p.id === body.id) : false;
      return new Response(null, { status: known ? 204 : 404 });
    }
    if (u.pathname.startsWith('/remote/boxes/') && method === 'DELETE') {
      const boxId = decodeURIComponent(u.pathname.slice('/remote/boxes/'.length));
      const r = opts.reap?.(boxId);
      if (!r) return new Response(null, { status: 404 });
      return jsonRes({ boxId, ...r });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('ControlPlaneAdminClient', () => {
  it('aggregates pending prompts across every registered box', async () => {
    const { fetchImpl } = fakeControlBox({
      boxes: [
        { boxId: 'b1', name: 'one' },
        { boxId: 'b2', name: 'two' },
      ],
      prompts: {
        b1: [{ id: 'p1', message: 'push?' }],
        b2: [{ id: 'p2', message: 'cp?' }],
      },
    });
    const client = new ControlPlaneAdminClient({ url: 'http://cb.test', adminToken: 'a', fetchImpl });
    const pending = await client.pendingPrompts();
    expect(pending.map((p) => `${p.boxName}:${p.prompt.id}`).sort()).toEqual(['one:p1', 'two:p2']);
  });

  it('answers a known prompt (true) and reports an unknown one (false)', async () => {
    const { fetchImpl } = fakeControlBox({ prompts: { b1: [{ id: 'p1', message: 'go?' }] } });
    const client = new ControlPlaneAdminClient({ url: 'http://cb.test', adminToken: 'a', fetchImpl });
    expect(await client.answerPrompt('p1', 'y')).toBe(true);
    expect(await client.answerPrompt('nope', 'n')).toBe(false);
  });

  it('reaps a box via DELETE /remote/boxes/:id', async () => {
    const { fetchImpl, calls } = fakeControlBox({
      reap: (boxId) => (boxId === 'b1' ? { removed: true, custodyRemoved: 2 } : null),
    });
    const client = new ControlPlaneAdminClient({ url: 'http://cb.test', adminToken: 'a', fetchImpl });
    expect(await client.reapBox('b1')).toEqual({ boxId: 'b1', removed: true, custodyRemoved: 2 });
    expect(await client.reapBox('ghost')).toEqual({ boxId: 'ghost', removed: false, custodyRemoved: 0 });
    expect(calls).toContain('DELETE /remote/boxes/b1');
  });
});
