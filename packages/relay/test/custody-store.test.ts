import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
    await expect(store.put('secrets/foo', Buffer.from('x'))).rejects.toBeInstanceOf(CustodyPathError);
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
