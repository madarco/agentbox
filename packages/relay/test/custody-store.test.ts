import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsCustodyStore } from '../src/custody/fs-store.js';
import { CustodyPathError, custodyDigest, normalizeCustodyPath } from '../src/custody/store.js';

describe('FsCustodyStore', () => {
  let root: string;
  let store: FsCustodyStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'custody-test-'));
    store = new FsCustodyStore({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips bytes with metadata', async () => {
    const data = Buffer.from('{"claudeAiOauth":{"refreshToken":"abc"}}');
    const put = await store.put('agents/claude/.credentials.json', data);
    expect(put.changed).toBe(true);
    expect(put.sha256).toBe(custodyDigest(data));
    expect(put.size).toBe(data.length);

    const got = await store.get('agents/claude/.credentials.json');
    expect(got).not.toBeNull();
    expect(got!.data.equals(data)).toBe(true);
    expect(got!.entry.sha256).toBe(put.sha256);
  });

  it('skips an unchanged re-push (content hash, not timestamp) and leaves mtime alone', async () => {
    const data = Buffer.from('secret-value');
    const first = await store.put('projects/acme__widgets/.env', data);
    const abs = join(root, 'projects/acme__widgets/.env');
    const mtime1 = (await stat(abs)).mtimeMs;

    const second = await store.put('projects/acme__widgets/.env', data);
    expect(second.changed).toBe(false);
    expect(second.sha256).toBe(first.sha256);
    const mtime2 = (await stat(abs)).mtimeMs;
    expect(mtime2).toBe(mtime1);

    const third = await store.put('projects/acme__widgets/.env', Buffer.from('new-value'));
    expect(third.changed).toBe(true);
    expect(third.sha256).not.toBe(first.sha256);
  });

  it('writes 0600 files under 0700 dirs', async () => {
    await store.put('boxes/box-1/ssh/id_ed25519', Buffer.from('KEY'));
    const fileMode = (await stat(join(root, 'boxes/box-1/ssh/id_ed25519'))).mode & 0o777;
    const dirMode = (await stat(join(root, 'boxes/box-1/ssh'))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('lists a scope prefix (manifest) sorted, values excluded', async () => {
    await store.put('agents/claude/.credentials.json', Buffer.from('a'));
    await store.put('agents/codex/auth.json', Buffer.from('b'));
    await store.put('projects/p/.env', Buffer.from('c'));

    const agents = await store.list('agents');
    expect(agents.map((e) => e.path)).toEqual([
      'agents/claude/.credentials.json',
      'agents/codex/auth.json',
    ]);
    // A manifest carries no bytes.
    expect(agents[0]).not.toHaveProperty('data');

    const all = await store.list();
    expect(all).toHaveLength(3);
  });

  it('prefix match respects path boundaries', async () => {
    await store.put('boxes/abc/ssh/key', Buffer.from('x'));
    await store.put('boxes/abcd/ssh/key', Buffer.from('y'));
    const hit = await store.list('boxes/abc');
    expect(hit.map((e) => e.path)).toEqual(['boxes/abc/ssh/key']);
  });

  it('deletes and reports absence', async () => {
    await store.put('agents/codex/auth.json', Buffer.from('z'));
    expect(await store.delete('agents/codex/auth.json')).toBe(true);
    expect(await store.delete('agents/codex/auth.json')).toBe(false);
    expect(await store.get('agents/codex/auth.json')).toBeNull();
  });

  it('stat returns metadata only, null when absent', async () => {
    await store.put('agents/claude/.credentials.json', Buffer.from('hi'));
    const s = await store.stat('agents/claude/.credentials.json');
    expect(s?.size).toBe(2);
    expect(await store.stat('agents/claude/missing')).toBeNull();
  });

  it('ignores stray .tmp files in the manifest', async () => {
    await store.put('agents/claude/.credentials.json', Buffer.from('real'));
    await writeFile(join(root, 'agents/claude/.credentials.json.abc.tmp'), 'half');
    const list = await store.list('agents');
    expect(list.map((e) => e.path)).toEqual(['agents/claude/.credentials.json']);
  });

  it('rejects path traversal and unknown scopes/agents', async () => {
    await expect(store.put('../escape', Buffer.from('x'))).rejects.toBeInstanceOf(CustodyPathError);
    await expect(store.put('agents/../../etc/passwd', Buffer.from('x'))).rejects.toBeInstanceOf(
      CustodyPathError,
    );
    await expect(store.put('secrets/foo', Buffer.from('x'))).rejects.toBeInstanceOf(
      CustodyPathError,
    );
    await expect(store.put('agents/gemini/auth.json', Buffer.from('x'))).rejects.toBeInstanceOf(
      CustodyPathError,
    );
  });
});

describe('normalizeCustodyPath', () => {
  it('strips leading/trailing slashes and accepts every scope', () => {
    expect(normalizeCustodyPath('/agents/claude/.credentials.json/')).toBe(
      'agents/claude/.credentials.json',
    );
    expect(normalizeCustodyPath('projects/p/.env')).toBe('projects/p/.env');
    expect(normalizeCustodyPath('boxes/b/ssh/id_ed25519')).toBe('boxes/b/ssh/id_ed25519');
    // Shared bake records: one per provider (see prepared-sync.ts).
    expect(normalizeCustodyPath('prepared/hetzner.json')).toBe('prepared/hetzner.json');
    // Project seed material a hub-created box needs (untracked files + env).
    expect(normalizeCustodyPath('projects/o__r/seed/untracked.tar.gz')).toBe(
      'projects/o__r/seed/untracked.tar.gz',
    );
  });

  it('rejects too-deep, empty-segment, and dotdot paths', () => {
    expect(() => normalizeCustodyPath('agents/claude/a/b/c/d/e')).toThrow(CustodyPathError);
    expect(() => normalizeCustodyPath('agents')).toThrow(CustodyPathError);
    expect(() => normalizeCustodyPath('agents/claude/..')).toThrow(CustodyPathError);
    expect(() => normalizeCustodyPath('agents/claude/a b')).toThrow(CustodyPathError);
  });
});

/**
 * The streaming pair exists so a `carry:` payload — bounded only by
 * `box.cpMaxBytes` (100 MiB) — never has to be held twice as base64. These pin
 * the properties that make it a safe substitute for `put`/`get`, not just a
 * faster one.
 */
describe('FsCustodyStore streaming', () => {
  let root: string;
  let store: FsCustodyStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'custody-stream-test-'));
    store = new FsCustodyStore({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const streamOf = (data: Buffer): Readable => Readable.from([data]);

  it('round-trips bytes and agrees with put() on the digest', async () => {
    const data = Buffer.from('carry payload contents');
    const res = await store.putStream('projects/acme__web/seed/carry.tar.gz', streamOf(data));
    expect(res.changed).toBe(true);
    expect(res.size).toBe(data.length);
    expect(res.sha256).toBe(custodyDigest(data));

    const got = await store.getStream('projects/acme__web/seed/carry.tar.gz');
    expect(got).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of got!.data) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe(data.toString());
  });

  it('keeps the content-addressed skip', async () => {
    const data = Buffer.from('same bytes');
    await store.putStream('projects/acme__web/seed/carry.tar.gz', streamOf(data));
    const second = await store.putStream('projects/acme__web/seed/carry.tar.gz', streamOf(data));
    expect(second.changed).toBe(false);
  });

  it('is interchangeable with put(): same path, same digest', async () => {
    const data = Buffer.from('written two ways');
    await store.put('projects/acme__web/seed/env.tar.gz', data);
    const viaStream = await store.putStream('projects/acme__web/seed/env.tar.gz', streamOf(data));
    expect(viaStream.changed).toBe(false);
    expect(viaStream.sha256).toBe(custodyDigest(data));
  });

  it('cuts off an over-cap body mid-stream and leaves nothing behind', async () => {
    const data = Buffer.alloc(4096, 0x61);
    await expect(
      store.putStream('projects/acme__web/seed/carry.tar.gz', streamOf(data), { maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds the custody blob cap/);
    // No entry, and no `.tmp` litter — an aborted upload must not leave a
    // half-written payload where a later read could find it.
    expect(await store.getStream('projects/acme__web/seed/carry.tar.gz')).toBeNull();
    const leftovers = (await readdir(join(root, 'projects/acme__web/seed'))).filter((f) =>
      f.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('does not clobber an existing entry when the new upload is rejected', async () => {
    const good = Buffer.from('the good copy');
    await store.put('projects/acme__web/seed/carry.tar.gz', good);
    await expect(
      store.putStream('projects/acme__web/seed/carry.tar.gz', streamOf(Buffer.alloc(4096)), {
        maxBytes: 16,
      }),
    ).rejects.toThrow();
    const still = await store.get('projects/acme__web/seed/carry.tar.gz');
    expect(still?.data.toString()).toBe(good.toString());
  });

  it('returns null for a missing entry rather than throwing', async () => {
    expect(await store.getStream('projects/acme__web/seed/nope.tar.gz')).toBeNull();
  });
});
