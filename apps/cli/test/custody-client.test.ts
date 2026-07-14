import { describe, expect, it } from 'vitest';
import {
  CustodyClient,
  planPush,
  sha256Hex,
  type CustodyEntry,
} from '../src/control-plane/custody-client.js';

// Pure — no HOME, no network (apps/cli tests have no HOME isolation, so these
// deliberately avoid readCredentialBackup / the real ~/.agentbox backups).

function entry(path: string, data: Buffer): CustodyEntry {
  return { path, size: data.length, sha256: sha256Hex(data), mode: 0o600, updatedAt: '2026-01-01T00:00:00Z' };
}

describe('planPush (hash-skip decision)', () => {
  it('skips items whose stored hash already matches', () => {
    const data = Buffer.from('same');
    const items = [{ path: 'agents/claude/.credentials.json', data }];
    const manifest = [entry('agents/claude/.credentials.json', data)];
    expect(planPush(items, manifest)[0]).toMatchObject({ action: 'skip', reason: 'hash match' });
  });

  it('uploads changed and new items', () => {
    const manifest = [entry('agents/claude/.credentials.json', Buffer.from('old'))];
    const decisions = planPush(
      [
        { path: 'agents/claude/.credentials.json', data: Buffer.from('new') },
        { path: 'agents/codex/auth.json', data: Buffer.from('fresh') },
      ],
      manifest,
    );
    expect(decisions[0]).toMatchObject({ action: 'upload', reason: 'changed' });
    expect(decisions[1]).toMatchObject({ action: 'upload', reason: 'new' });
  });

  it('force uploads even on a hash match', () => {
    const data = Buffer.from('same');
    const items = [{ path: 'projects/p/.env', data }];
    const manifest = [entry('projects/p/.env', data)];
    expect(planPush(items, manifest, { force: true })[0]).toMatchObject({ action: 'upload', reason: 'forced' });
  });
});

describe('CustodyClient (fake fetch)', () => {
  it('lists, puts, and gets via the admin bearer', async () => {
    const store = new Map<string, Buffer>();
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth !== 'Bearer tok') return new Response('no', { status: 401 });
      const prefix = '/admin/custody';
      if (url.pathname === prefix && (init?.method ?? 'GET') === 'GET') {
        const entries = [...store.entries()].map(([p, d]) => entry(p, d));
        return new Response(JSON.stringify({ entries }), { status: 200 });
      }
      const rel = decodeURIComponent(url.pathname.slice(`${prefix}/`.length));
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { data: string };
        const data = Buffer.from(body.data, 'base64');
        const changed = !store.get(rel)?.equals(data);
        store.set(rel, data);
        return new Response(JSON.stringify({ changed, sha256: sha256Hex(data) }), { status: 200 });
      }
      const got = store.get(rel);
      if (!got) return new Response(JSON.stringify({ error: 'x' }), { status: 404 });
      return new Response(JSON.stringify({ data: got.toString('base64') }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new CustodyClient({ url: 'https://plane.example', adminToken: 'tok', fetchImpl });
    const put = await client.put('agents/claude/.credentials.json', Buffer.from('cred'));
    expect(put.changed).toBe(true);
    expect(await client.list('agents')).toHaveLength(1);
    const got = await client.get('agents/claude/.credentials.json');
    expect(got?.toString()).toBe('cred');
    expect(await client.get('agents/codex/auth.json')).toBeNull();
  });
});
