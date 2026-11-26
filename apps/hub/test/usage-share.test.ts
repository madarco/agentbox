import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageShare, parseShareBody, usageFixture } from '@agentbox/usage-view';
import {
  ShareError,
  fileClaimStore,
  parseShareEndpoint,
  postUsageShare,
  previewUsageShare,
  type ClaimStore,
  type UsageShareDeps,
} from '../lib/backend/usage-share';

let dir: string;
let claims: ClaimStore;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usage-share-'));
  path = join(dir, 'hub', 'share.json');
  claims = fileClaimStore(path);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  url: string;
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
      auth: headers.get('authorization'),
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const created = (n: number, secret?: string, origin = 'https://agent-box.sh'): Response =>
  Response.json(
    {
      url: `${origin}/u/marco/${String(n)}`,
      handle: 'marco',
      n,
      ...(secret ? { claimSecret: secret } : {}),
    },
    { status: 201 },
  );

function deps(over: Partial<UsageShareDeps> = {}): UsageShareDeps {
  return {
    stats: () => Promise.resolve(usageFixture()),
    endpoint: () => Promise.resolve(undefined),
    claims,
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
    const f = fakeFetch(() => created(1));
    const p = await previewUsageShare(deps({ fetch: f.fetch }), 'marco');
    expect(f.calls).toHaveLength(0);
    expect(UsageShare.parse(p.share).handle).toBe('marco');
    expect(p.bytes).toBe(Buffer.byteLength(JSON.stringify(p.share)));
    // Nothing named survives: no box, project, PR or session titles.
    const text = JSON.stringify(p.share);
    for (const b of usageFixture().boxes) expect(text).not.toContain(`"${b.name}"`);
  });
  it('refuses a bad handle before reading stats', async () => {
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
    await expect(previewUsageShare(d, '')).rejects.toBeInstanceOf(ShareError);
    expect(read).toBe(false);
  });
});

describe('postUsageShare', () => {
  it('posts a body the site parses, keeps the claim secret, sends it next time', async () => {
    const f = fakeFetch((_c, i) => (i === 0 ? created(1, 'sekrit') : created(2)));
    const first = await postUsageShare(deps({ fetch: f.fetch }), 'marco');
    expect(first).toEqual({
      url: 'https://agent-box.sh/u/marco/1',
      handle: 'marco',
      n: 1,
      claimedNow: true,
    });
    expect(f.calls[0]!.url).toBe('https://agent-box.sh/api/share');
    expect(f.calls[0]!.auth).toBeNull();
    expect(parseShareBody(f.calls[0]!.body).handle).toBe('marco');
    // The secret is in the file (0600) and never in the answer.
    expect(JSON.stringify(first)).not.toContain('sekrit');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain('sekrit');

    const second = await postUsageShare(deps({ fetch: f.fetch }), 'marco');
    expect(second.claimedNow).toBe(false);
    expect(f.calls[1]!.auth).toBe('Bearer sekrit');
    expect(await claims.known('https://agent-box.sh')).toEqual({
      handles: ['marco'],
      lastHandle: 'marco',
    });
  });

  it('keeps claims per site: a preview deployment gets no production secret', async () => {
    await claims.save('https://agent-box.sh', 'marco', 'prod-secret');
    const f = fakeFetch(() => created(1, 'preview-secret', 'https://preview.vercel.app'));
    await postUsageShare(
      deps({
        fetch: f.fetch,
        endpoint: () => Promise.resolve('https://preview.vercel.app/api/share'),
      }),
      'marco',
    );
    expect(f.calls[0]!.auth).toBeNull();
    expect(await claims.secret('https://preview.vercel.app', 'marco')).toBe('preview-secret');
    expect(await claims.secret('https://agent-box.sh', 'marco')).toBe('prod-secret');
  });

  const errorCases: [number, string, Record<string, string>?][] = [
    [400, 'upstream_error'],
    [403, 'conflict'],
    [409, 'conflict'],
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
      if (status === 429) {
        expect((err as ShareError).retryAfter).toBe(1800);
        expect((err as ShareError).message).toContain('30 min');
      }
    });
  }

  it('says whose claim was refused', async () => {
    const f = fakeFetch(() => Response.json({}, { status: 403 }));
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toThrow(
      /already claimed/,
    );
    await claims.save('https://agent-box.sh', 'marco', 'old');
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toThrow(
      /refused the claim secret/,
    );
  });

  it('reports an unreachable site and a reply without a URL', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(postUsageShare(deps({ fetch: down }), 'marco')).rejects.toMatchObject({
      code: 'upstream_error',
    });
    const f = fakeFetch(() => Response.json({ n: 1 }, { status: 201 }));
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('refuses a share URL on another site', async () => {
    const f = fakeFetch(() =>
      Response.json({ url: 'https://evil.example/u/marco/1', n: 1 }, { status: 201 }),
    );
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('names the public URL and keeps the secret aside when it cannot be saved', async () => {
    const salvaged: string[] = [];
    const broken: ClaimStore = {
      ...claims,
      save: () => Promise.reject(new Error('EACCES')),
      salvage: (_o, _h, secret) => {
        salvaged.push(secret);
        return Promise.resolve('/x/share.json.claim-marco.json');
      },
    };
    const f = fakeFetch(() => created(1, 'sekrit'));
    const err = (await postUsageShare(deps({ fetch: f.fetch, claims: broken }), 'marco').catch(
      (e: unknown) => e,
    )) as ShareError;
    expect(err.message).toContain('https://agent-box.sh/u/marco/1');
    expect(err.message).toContain('/x/share.json.claim-marco.json');
    expect(err.message).not.toContain('sekrit');
    expect(salvaged).toEqual(['sekrit']);
  });

  it('salvage writes a 0600 file of its own', async () => {
    await claims.save('https://agent-box.sh', 'x', 's');
    const file = await claims.salvage!('https://agent-box.sh', 'marco', 'sekrit');
    expect(file).toBeTruthy();
    expect((await stat(file!)).mode & 0o777).toBe(0o600);
    expect(await readFile(file!, 'utf8')).toContain('sekrit');
  });

  it('remembers the last handle per site', async () => {
    const f = fakeFetch(() => created(1, 's', 'https://preview.vercel.app'));
    await postUsageShare(
      deps({
        fetch: f.fetch,
        endpoint: () => Promise.resolve('https://preview.vercel.app/api/share'),
      }),
      'test-x',
    );
    expect((await claims.known('https://preview.vercel.app')).lastHandle).toBe('test-x');
    expect((await claims.known('https://agent-box.sh')).lastHandle).toBeNull();
  });

  it('keeps a minted secret even when the returned URL is on another site', async () => {
    const f = fakeFetch(() =>
      Response.json(
        { url: 'https://evil.example/u/marco/1', n: 1, claimSecret: 'minted' },
        { status: 201 },
      ),
    );
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toThrow(
      /claimed and its secret kept/,
    );
    expect(await claims.secret('https://agent-box.sh', 'marco')).toBe('minted');
  });

  it('says a lost answer may still have claimed the handle', async () => {
    const timeout = (() =>
      Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))) as typeof fetch;
    await expect(postUsageShare(deps({ fetch: timeout }), 'marco')).rejects.toThrow(
      /may have been published and "marco" claimed anyway/,
    );
    await claims.save('https://agent-box.sh', 'marco', 's');
    await expect(postUsageShare(deps({ fetch: timeout }), 'marco')).rejects.toThrow(
      /check https:\/\/agent-box.sh\/u\/marco before retrying/,
    );
  });

  it('never quotes a corrupt claim file in the error', async () => {
    await claims.save('https://agent-box.sh', 'x', 's');
    await writeFile(path, '{"claims": {"k": {"secret": "abcdef-leak');
    const err = (await claims.known('https://agent-box.sh').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ShareError);
    expect(err.message).not.toContain('abcdef');
    expect(err.message).toContain('not valid JSON');
  });

  it('does not overwrite a corrupt claim file', async () => {
    await claims.save('https://agent-box.sh', 'x', 's');
    await writeFile(path, '{ not json');
    const f = fakeFetch(() => created(1, 'new'));
    await expect(postUsageShare(deps({ fetch: f.fetch }), 'marco')).rejects.toMatchObject({
      code: 'backend_unavailable',
    });
    expect(f.calls).toHaveLength(0);
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });
});
