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
  return {
    path,
    size: data.length,
    sha256: sha256Hex(data),
    mode: 0o600,
    updatedAt: '2026-01-01T00:00:00Z',
  };
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
    expect(planPush(items, manifest, { force: true })[0]).toMatchObject({
      action: 'upload',
      reason: 'forced',
    });
  });
});

describe('CustodyClient (fake fetch)', () => {
  // A fake of the `/api/v1/custody` route: the API key (Bearer) authorizes
  // list/put/delete; a byte-read GET additionally requires the admin token in
  // X-Agentbox-Admin-Token (mirrors the route's elevated byte-read gate).
  function fakeHub() {
    const store = new Map<string, Buffer>();
    const prefix = '/api/v1/custody';
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      if (headers.Authorization !== 'Bearer key') {
        return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
          status: 401,
        });
      }
      const method = init?.method ?? 'GET';
      if (url.pathname === prefix && method === 'GET') {
        const entries = [...store.entries()].map(([p, d]) => entry(p, d));
        return new Response(JSON.stringify({ enabled: true, entries }), { status: 200 });
      }
      const rel = decodeURIComponent(url.pathname.slice(`${prefix}/`.length));
      if (method === 'PUT') {
        const body = JSON.parse(String(init!.body)) as { data: string };
        const data = Buffer.from(body.data, 'base64');
        const changed = !store.get(rel)?.equals(data);
        store.set(rel, data);
        return new Response(JSON.stringify({ ...entry(rel, data), changed }), { status: 200 });
      }
      if (method === 'DELETE') {
        const had = store.delete(rel);
        return new Response(null, { status: had ? 204 : 404 });
      }
      // byte-read GET — the elevated gate.
      if (headers['X-Agentbox-Admin-Token'] !== 'admin') {
        return new Response(
          JSON.stringify({ error: { code: 'unauthorized', message: 'admin token required' } }),
          { status: 401 },
        );
      }
      const got = store.get(rel);
      if (!got)
        return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
      return new Response(JSON.stringify({ ...entry(rel, got), data: got.toString('base64') }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { fetchImpl };
  }

  it('lists, puts, gets (with the admin token), and deletes over /api/v1', async () => {
    const { fetchImpl } = fakeHub();
    const client = new CustodyClient({
      url: 'https://plane.example',
      apiKey: 'key',
      adminToken: 'admin',
      fetchImpl,
    });
    const put = await client.put('agents/claude/.credentials.json', Buffer.from('cred'));
    expect(put.changed).toBe(true);
    expect(await client.list('agents')).toHaveLength(1);
    const got = await client.get('agents/claude/.credentials.json');
    expect(got?.toString()).toBe('cred');
    expect(await client.get('agents/codex/auth.json')).toBeNull();
    expect(await client.delete('agents/claude/.credentials.json')).toBe(true);
    expect(await client.delete('agents/claude/.credentials.json')).toBe(false);
  });

  it('a byte-read WITHOUT the admin token is refused (the metadata-only contract)', async () => {
    const { fetchImpl } = fakeHub();
    // A thin client: API key only, no admin token — can list + write.
    const thin = new CustodyClient({ url: 'https://plane.example', apiKey: 'key', fetchImpl });
    await thin.put('agents/claude/.credentials.json', Buffer.from('cred'));
    expect(await thin.list('agents')).toHaveLength(1);
    // ...but cannot read the stored value.
    await expect(thin.get('agents/claude/.credentials.json')).rejects.toThrow(/admin token/i);
  });

  // A fake of the internal `/admin/custody` wire: the admin token (Bearer)
  // authorizes every verb, byte-read included (loopback-gated, no elevation split).
  function fakeAdminHub() {
    const store = new Map<string, Buffer>();
    const prefix = '/admin/custody';
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      if (url.pathname.startsWith('/api/v1/')) {
        throw new Error(`admin-only client must not hit /api/v1 (got ${url.pathname})`);
      }
      if (headers.Authorization !== 'Bearer admin') {
        return new Response(JSON.stringify({ error: 'invalid admin token' }), { status: 401 });
      }
      const method = init?.method ?? 'GET';
      if (url.pathname === prefix && method === 'GET') {
        const entries = [...store.entries()].map(([p, d]) => entry(p, d));
        return new Response(JSON.stringify({ entries }), { status: 200 });
      }
      const rel = decodeURIComponent(url.pathname.slice(`${prefix}/`.length));
      if (method === 'PUT') {
        const data = Buffer.from((JSON.parse(String(init!.body)) as { data: string }).data, 'base64');
        const changed = !store.get(rel)?.equals(data);
        store.set(rel, data);
        return new Response(JSON.stringify({ ...entry(rel, data), changed }), { status: 200 });
      }
      const got = store.get(rel);
      if (!got) return new Response(JSON.stringify({ error: 'no such custody entry' }), { status: 404 });
      return new Response(JSON.stringify({ ...entry(rel, got), data: got.toString('base64') }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { fetchImpl };
  }

  it('falls back to /admin/custody when only the admin token is available (byte-read works)', async () => {
    // The via-hub-create / SSH-key-pull case: a machine that ran `hub setup` but has
    // no API key must still push AND read (pull) via the admin wire — never no-op.
    const { fetchImpl } = fakeAdminHub();
    const client = new CustodyClient({ url: 'https://plane.example', adminToken: 'admin', fetchImpl });
    await client.put('boxes/sb-1/ssh/id_ed25519', Buffer.from('PRIVKEY'));
    expect(await client.list('boxes')).toHaveLength(1);
    // The byte-read succeeds on the admin wire (no API key needed there).
    expect((await client.get('boxes/sb-1/ssh/id_ed25519'))?.toString()).toBe('PRIVKEY');
  });

  it('throws when constructed with NEITHER credential (never a silent no-op)', () => {
    expect(() => new CustodyClient({ url: 'https://plane.example' })).toThrow(
      /API key or an admin token/i,
    );
  });
});
