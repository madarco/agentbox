import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageShare, parseShareBody, usageFixture } from '@agentbox/usage-view';
import {
  ShareError,
  deleteUsageShare,
  fileShareStore,
  listUsageShares,
  parseShareEndpoint,
  postUsageShare,
  previewUsageShare,
  type ShareStore,
  type UsageShareDeps,
} from '../lib/backend/usage-share';

let dir: string;
let store: ShareStore;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usage-share-'));
  path = join(dir, 'hub', 'share.json');
  store = fileShareStore(path);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string;
}

function fakeFetch(respond: (call: Call, i: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const ID1 = 'a1b2c3d4e5f6g7h8i9j0k1l2';
const ID2 = 'zz9yy8xx7ww6vv5uu4tt3ss2';

const created = (id = ID1, secret = `secret-${id}`, origin = 'https://agent-box.sh'): Response =>
  Response.json({ url: `${origin}/s/${id}`, id, deleteSecret: secret }, { status: 201 });

function deps(over: Partial<UsageShareDeps> = {}): UsageShareDeps {
  return {
    stats: () => Promise.resolve(usageFixture()),
    endpoint: () => Promise.resolve(undefined),
    store,
    ...over,
  };
}

describe('parseShareEndpoint', () => {
  it('defaults to agent-box.sh', () => {
    expect(parseShareEndpoint(undefined).href).toBe('https://agent-box.sh/api/share');
    expect(parseShareEndpoint('  ').href).toBe('https://agent-box.sh/api/share');
  });
  it('takes https anywhere and http only on this machine', () => {
    expect(parseShareEndpoint('https://x.vercel.app/api/share').host).toBe('x.vercel.app');
    expect(parseShareEndpoint('http://localhost:3000/api/share').port).toBe('3000');
    expect(() => parseShareEndpoint('http://example.com/api/share')).toThrow(ShareError);
    expect(() => parseShareEndpoint('ftp://localhost/x')).toThrow(ShareError);
    expect(() => parseShareEndpoint('not a url')).toThrow(ShareError);
    expect(() => parseShareEndpoint('https://u:p@agent-box.sh/api/share')).toThrow(ShareError);
  });
});

describe('previewUsageShare', () => {
  it('returns the exact share that would be posted, posting nothing', async () => {
    const f = fakeFetch(() => created());
    const p = await previewUsageShare(deps({ fetch: f.fetch }), 'marco');
    expect(f.calls).toHaveLength(0);
    expect(UsageShare.parse(p.share).name).toBe('marco');
    expect(p.bytes).toBe(Buffer.byteLength(JSON.stringify(p.share)));
    // Nothing named survives: no box, project, PR or session titles.
    const text = JSON.stringify(p.share);
    for (const b of usageFixture().boxes) expect(text).not.toContain(`"${b.name}"`);
  });
  it('builds a share with no name when none is given', async () => {
    for (const n of [undefined, null, '', '  ']) {
      const p = await previewUsageShare(deps(), n);
      expect('name' in p.share).toBe(false);
    }
  });
  it('refuses a bad name before reading stats', async () => {
    let read = false;
    const d = deps({
      stats: () => {
        read = true;
        return Promise.resolve(usageFixture());
      },
    });
    await expect(previewUsageShare(d, 'Marco!')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(previewUsageShare(d, 42)).rejects.toBeInstanceOf(ShareError);
    expect(read).toBe(false);
  });
});

describe('postUsageShare', () => {
  it('posts a body the site parses, keeps the delete secret, never returns it', async () => {
    const f = fakeFetch(() => created());
    const first = await postUsageShare(deps({ fetch: f.fetch }), 'marco');
    expect(first).toMatchObject({ url: `https://agent-box.sh/s/${ID1}`, id: ID1 });
    expect(Object.keys(first).sort()).toEqual(['createdAt', 'id', 'url']);
    expect(f.calls[0]!.url).toBe('https://agent-box.sh/api/share');
    expect(f.calls[0]!.method).toBe('POST');
    expect(f.calls[0]!.auth).toBeNull();
    expect(parseShareBody(f.calls[0]!.body).name).toBe('marco');
    // The secret is in the file (0600) and never in the answer or the listing.
    expect(JSON.stringify(first)).not.toContain(`secret-${ID1}`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain(`secret-${ID1}`);
    const listed = await listUsageShares(store);
    expect(listed).toEqual([
      {
        endpoint: 'https://agent-box.sh/api/share',
        origin: 'https://agent-box.sh',
        id: ID1,
        url: `https://agent-box.sh/s/${ID1}`,
        createdAt: first.createdAt,
      },
    ]);
    expect(await store.lastName()).toBe('marco');
  });

  it('lists shares newest first, across sites', async () => {
    const f = fakeFetch((_c, i) =>
      i === 0 ? created(ID1) : created(ID2, 's2', 'https://preview.vercel.app'),
    );
    await postUsageShare(deps({ fetch: f.fetch }), undefined);
    await new Promise((r) => setTimeout(r, 5));
    await postUsageShare(
      deps({
        fetch: f.fetch,
        endpoint: () => Promise.resolve('https://preview.vercel.app/api/share'),
      }),
      undefined,
    );
    expect((await listUsageShares(store)).map((s) => [s.id, s.origin])).toEqual([
      [ID2, 'https://preview.vercel.app'],
      [ID1, 'https://agent-box.sh'],
    ]);
    expect(await store.lastName()).toBeNull();
  });

  const errorCases: [number, string, Record<string, string>?][] = [
    [400, 'upstream_error'],
    [403, 'upstream_error'],
    [413, 'payload_too_large'],
    [429, 'rate_limited', { 'retry-after': '1800' }],
    [503, 'backend_unavailable'],
    [500, 'upstream_error'],
  ];
  for (const [status, code, headers] of errorCases) {
    it(`maps the site's ${String(status)} to ${code}`, async () => {
      const f = fakeFetch(() =>
        Response.json({ error: 'site text' }, { status, headers: headers ?? {} }),
      );
      const err = await postUsageShare(deps({ fetch: f.fetch }), 'marco').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShareError);
      expect((err as ShareError).code).toBe(code);
      expect((err as ShareError).message).not.toContain('site text');
      if (status === 429) {
        expect((err as ShareError).retryAfter).toBe(1800);
        expect((err as ShareError).message).toContain('30 min');
      }
    });
  }

  it('reports an unreachable site, and a lost answer as maybe published', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(postUsageShare(deps({ fetch: down }), 'marco')).rejects.toMatchObject({
      code: 'upstream_error',
    });
    const timeout = (() =>
      Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))) as typeof fetch;
    await expect(postUsageShare(deps({ fetch: timeout }), 'marco')).rejects.toThrow(
      /may have been published anyway/,
    );
  });

  it('refuses a reply without an id or secret, or with a malformed id', async () => {
    for (const body of [
      { url: `https://agent-box.sh/s/${ID1}` },
      { url: `https://agent-box.sh/s/${ID1}`, id: ID1 },
      { url: 'https://agent-box.sh/s/x', id: '../x', deleteSecret: 's' },
    ]) {
      const f = fakeFetch(() => Response.json(body, { status: 201 }));
      await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toMatchObject({
        code: 'upstream_error',
      });
    }
    expect(await store.list()).toEqual([]);
  });

  it('keeps the secret of a share whose URL is on another site, and refuses the URL', async () => {
    const f = fakeFetch(() =>
      Response.json(
        { url: `https://evil.example/s/${ID1}`, id: ID1, deleteSecret: 'minted' },
        { status: 201 },
      ),
    );
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toThrow(
      /can be deleted/,
    );
    const [kept] = await store.list();
    expect(kept).toMatchObject({ id: ID1, url: '', deleteSecret: 'minted' });
  });

  it('names the public URL and keeps the secret aside when it cannot be saved', async () => {
    const salvaged: string[] = [];
    const broken: ShareStore = {
      ...store,
      add: () => Promise.reject(new Error('EACCES')),
      salvage: (r) => {
        salvaged.push(r.deleteSecret);
        return Promise.resolve(`/x/share.json.share-${r.id}.json`);
      },
    };
    const f = fakeFetch(() => created(ID1, 'sekrit'));
    const err = (await postUsageShare(deps({ fetch: f.fetch, store: broken }), 'marco').catch(
      (e: unknown) => e,
    )) as ShareError;
    expect(err.message).toContain(`https://agent-box.sh/s/${ID1}`);
    expect(err.message).toContain(`/x/share.json.share-${ID1}.json`);
    expect(err.message).not.toContain('sekrit');
    expect(salvaged).toEqual(['sekrit']);
  });

  it('salvage writes a 0600 file of its own', async () => {
    const file = await store.salvage!({
      endpoint: 'https://agent-box.sh/api/share',
      origin: 'https://agent-box.sh',
      id: ID1,
      url: '',
      deleteSecret: 'sekrit',
      createdAt: new Date().toISOString(),
    });
    expect(file).toBeTruthy();
    expect((await stat(file!)).mode & 0o777).toBe(0o600);
    expect(await readFile(file!, 'utf8')).toContain('sekrit');
  });

  it('never quotes a corrupt share file in the error', async () => {
    await store.rememberName('x');
    await writeFile(path, '{"shares": [{"deleteSecret": "abcdef-leak');
    const err = (await store.list().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ShareError);
    expect(err.message).not.toContain('abcdef');
    expect(err.message).toContain('not valid JSON');
  });

  it('posts nothing and leaves a corrupt share file alone', async () => {
    await store.rememberName('x');
    await writeFile(path, '{ not json');
    const f = fakeFetch(() => created());
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toMatchObject({
      code: 'backend_unavailable',
    });
    expect(f.calls).toHaveLength(0);
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });
});

describe('deleteUsageShare', () => {
  async function shared(endpoint?: string): Promise<void> {
    const f = fakeFetch(() =>
      created(ID1, `secret-${ID1}`, endpoint ? new URL(endpoint).origin : undefined),
    );
    await postUsageShare(
      deps({ fetch: f.fetch, ...(endpoint ? { endpoint: () => Promise.resolve(endpoint) } : {}) }),
      'marco',
    );
  }

  it('sends the delete secret to the site that minted it, then forgets the share', async () => {
    await shared('http://localhost:3000/api/share');
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    expect(await deleteUsageShare({ store, fetch: f.fetch }, ID1)).toEqual({
      id: ID1,
      deleted: true,
    });
    expect(f.calls).toEqual([
      {
        url: `http://localhost:3000/api/share/${ID1}`,
        method: 'DELETE',
        auth: `Bearer secret-${ID1}`,
        body: '',
      },
    ]);
    expect(await store.list()).toEqual([]);
  });

  it('forgets a share the site no longer has', async () => {
    await shared();
    const f = fakeFetch(() => Response.json({}, { status: 404 }));
    expect(await deleteUsageShare({ store, fetch: f.fetch }, ID1)).toEqual({
      id: ID1,
      deleted: false,
    });
    expect(await store.list()).toEqual([]);
  });

  it('keeps the share when the site refuses or cannot be reached', async () => {
    await shared();
    const refused = fakeFetch(() => Response.json({}, { status: 403 }));
    await expect(deleteUsageShare({ store, fetch: refused.fetch }, ID1)).rejects.toMatchObject({
      code: 'conflict',
    });
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(deleteUsageShare({ store, fetch: down }, ID1)).rejects.toMatchObject({
      code: 'upstream_error',
    });
    const busy = fakeFetch(() => Response.json({}, { status: 503 }));
    await expect(deleteUsageShare({ store, fetch: busy.fetch }, ID1)).rejects.toMatchObject({
      code: 'backend_unavailable',
    });
    expect((await store.list()).map((s) => s.id)).toEqual([ID1]);
  });

  it('answers not_found for a share this hub did not make, calling nothing', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    for (const id of [ID2, '../../etc', '']) {
      await expect(deleteUsageShare({ store, fetch: f.fetch }, id)).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(f.calls).toHaveLength(0);
  });
});
