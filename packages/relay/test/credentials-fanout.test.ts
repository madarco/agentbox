import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsFanout, UNVERIFIABLE_ACCOUNT } from '../src/credentials-fanout.js';

const claudeBlob = (expiresAt: number, refresh = 'r') =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: refresh, expiresAt } });

const payload = (agent: string, content: string) => ({
  schema: 1,
  agent,
  contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  capturedAt: new Date(0).toISOString(),
});

describe('CredentialsFanout', () => {
  let dir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'fanout-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function make(runPropagate: (agent: string, box: string) => Promise<void>) {
    return new CredentialsFanout({
      log: () => {},
      debounceMs: 100,
      runPropagate,
      backupPathFor: (agent) => join(dir, `${agent}-credentials.json`),
    });
  }

  it('accepts a newer claude blob, rejects stale and duplicate ones', async () => {
    const runs: string[] = [];
    const fanout = make(async (agent, box) => {
      runs.push(`${agent}:${box}`);
    });
    expect((await fanout.handle('box-a', payload('claude', claudeBlob(100)))).accepted).toBe(true);
    expect((await fanout.handle('box-a', payload('claude', claudeBlob(100)))).accepted).toBe(false); // unchanged
    expect((await fanout.handle('box-b', payload('claude', claudeBlob(50, 'r2')))).accepted).toBe(
      false,
    ); // stale
    expect((await fanout.handle('box-b', payload('claude', claudeBlob(200, 'r3')))).accepted).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(150);
    await fanout.flush();
    // The two accepts within one debounce window collapse into one run.
    expect(runs).toEqual(['claude:box-b']);
  });

  it('routes a named box to its own account: its copy, its custody path, its fan-out (llm-accounts Phase 4)', async () => {
    const runs: string[] = [];
    const put = vi.fn().mockResolvedValue(undefined);
    const fanout = new CredentialsFanout({
      log: () => {},
      debounceMs: 100,
      runPropagate: async (agent, box, account) => {
        runs.push(`${agent}:${box}:${account}`);
      },
      backupPathFor: (agent) => join(dir, `${agent}-credentials.json`),
      accountBackupPathFor: (agent, account) => join(dir, 'credentials', agent, `${account}.json`),
      accountKindFor: () => Promise.resolve('login'),
      custody: { put },
      // The hub's own machine, not the box's origin PC (#444 (b)).
      machineId: () => '11111111-2222-3333-4444-555555555555',
      boxAccountFor: (boxId, agent) =>
        Promise.resolve(boxId === 'box-work' && agent === 'claude' ? 'work' : undefined),
    });
    expect((await fanout.handle('box-work', payload('claude', claudeBlob(999)))).accepted).toBe(
      true,
    );
    // The default login is untouched by the named update…
    await expect(readFile(join(dir, 'claude-credentials.json'), 'utf8')).rejects.toThrow();
    // …which lands in the account's own copy and custody path.
    expect(
      JSON.parse(await readFile(join(dir, 'credentials', 'claude', 'work.json'), 'utf8'))
        .claudeAiOauth.expiresAt,
    ).toBe(999);
    expect(put).toHaveBeenCalledWith(
      'agents/claude/accounts/11111111-2222-3333-4444-555555555555/work/.credentials.json',
      expect.anything(),
    );
    // A default box updates the default, on its own chain.
    expect((await fanout.handle('box-a', payload('claude', claudeBlob(100)))).accepted).toBe(true);
    expect(put).toHaveBeenCalledWith('agents/claude/.credentials.json', expect.anything());
    await vi.advanceTimersByTimeAsync(150);
    await fanout.flush();
    expect(runs.sort()).toEqual(['claude:box-a:default', 'claude:box-work:work']);
  });

  it('a named account has its own newest-wins gate', async () => {
    const fanout = new CredentialsFanout({
      log: () => {},
      debounceMs: 100,
      runPropagate: async () => {},
      backupPathFor: (agent) => join(dir, `${agent}-credentials.json`),
      accountBackupPathFor: (agent, account) => join(dir, 'credentials', agent, `${account}.json`),
      accountKindFor: () => Promise.resolve('login'),
      boxAccountFor: () => Promise.resolve('work'),
    });
    expect((await fanout.handle('b', payload('claude', claudeBlob(500)))).accepted).toBe(true);
    expect((await fanout.handle('b', payload('claude', claudeBlob(400, 'r2')))).accepted).toBe(
      false,
    );
  });

  it.each([
    ['a pasted-kind account', 'setup-token'],
    ['an account the store no longer has', undefined],
  ])('never writes a login into %s', async (_name, kind) => {
    const run = vi.fn();
    const fanout = new CredentialsFanout({
      log: () => {},
      debounceMs: 100,
      runPropagate: run,
      backupPathFor: (agent) => join(dir, `${agent}-credentials.json`),
      accountBackupPathFor: (agent, account) => join(dir, 'credentials', agent, `${account}.json`),
      accountKindFor: () => Promise.resolve(kind),
      boxAccountFor: () => Promise.resolve('ci'),
    });
    const r = await fanout.handle('b', payload('claude', claudeBlob(999)));
    expect(r.accepted).toBe(false);
    await expect(readFile(join(dir, 'credentials', 'claude', 'ci.json'), 'utf8')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();
  });

  it('drops an update whose box account cannot be verified', async () => {
    const run = vi.fn();
    const fanout = new CredentialsFanout({
      log: () => {},
      debounceMs: 100,
      runPropagate: run,
      backupPathFor: (agent) => join(dir, `${agent}-credentials.json`),
      boxAccountFor: () => Promise.resolve(UNVERIFIABLE_ACCOUNT),
    });
    const r = await fanout.handle('b', payload('claude', claudeBlob(999)));
    expect(r).toEqual({ accepted: false, reason: 'account unverifiable' });
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads without touching the backup', async () => {
    const run = vi.fn();
    const fanout = make(run);
    expect((await fanout.handle('box-a', { agent: 'claude' })).accepted).toBe(false);
    expect((await fanout.handle('box-a', null)).accepted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();
  });

  it('serializes fan-outs per agent (a fresh accept queues one more run)', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    const runs: string[] = [];
    const fanout = make(async (agent, box) => {
      runs.push(`start:${box}`);
      if (runs.length === 1) await gate;
      runs.push(`end:${box}`);
    });
    await fanout.handle('box-a', payload('codex', '{"v":1}'));
    await vi.advanceTimersByTimeAsync(150); // first run starts, blocked on gate
    await fanout.handle('box-b', payload('codex', '{"v":2}'));
    await vi.advanceTimersByTimeAsync(150); // second run chains behind the first
    expect(runs).toEqual(['start:box-a']);
    resolveFirst();
    await fanout.flush();
    expect(runs).toEqual(['start:box-a', 'end:box-a', 'start:box-b', 'end:box-b']);
  });

  it('codex/opencode use last-writer-wins on content change', async () => {
    const fanout = make(async () => {});
    expect((await fanout.handle('a', payload('opencode', '{"v":1}'))).accepted).toBe(true);
    expect((await fanout.handle('b', payload('opencode', '{"v":1}'))).accepted).toBe(false);
    expect((await fanout.handle('b', payload('opencode', '{"v":2}'))).accepted).toBe(true);
    await fanout.flush();
  });
});

describe('CredentialsFanout — custody write-back', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fanout-custody-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeWithCustody(put: (path: string, data: Buffer) => Promise<unknown>) {
    return new CredentialsFanout({
      log: () => {},
      debounceMs: 100,
      runPropagate: async () => {},
      backupPathFor: (agent) => join(dir, `${agent}-credentials.json`),
      custody: { put },
    });
  }

  // Without this the freshest token lives only in the host backup, and the next
  // hub create re-seeds that backup from custody's older copy — the box then
  // starts with a rotated-away (dead) credential.
  it('mirrors an accepted credential into custody', async () => {
    const puts: { path: string; text: string }[] = [];
    const fanout = makeWithCustody(async (path, data) => {
      puts.push({ path, text: data.toString('utf8') });
    });
    const blob = claudeBlob(3_000);

    expect((await fanout.handle('box-1', payload('claude', blob))).accepted).toBe(true);
    expect(puts).toEqual([{ path: 'agents/claude/.credentials.json', text: blob }]);
  });

  it('does not write custody for a rejected (stale) update', async () => {
    const puts: string[] = [];
    const fanout = makeWithCustody(async (path) => {
      puts.push(path);
    });
    await fanout.handle('box-1', payload('claude', claudeBlob(5_000)));
    puts.length = 0;

    const stale = await fanout.handle('box-2', payload('claude', claudeBlob(1_000)));
    expect(stale.accepted).toBe(false);
    expect(puts).toEqual([]);
  });

  it('still accepts and fans out when custody rejects the write', async () => {
    const fanout = makeWithCustody(() => Promise.reject(new Error('custody offline')));
    const res = await fanout.handle('box-1', payload('claude', claudeBlob(3_000)));
    // The fan-out is what repairs boxes already running — a custody hiccup
    // must not cost us that.
    expect(res.accepted).toBe(true);
  });

  it('uses each agent’s own custody path', async () => {
    const paths: string[] = [];
    const fanout = makeWithCustody(async (path) => {
      paths.push(path);
    });
    await fanout.handle('box-1', payload('codex', JSON.stringify({ tokens: { access: 'x' } })));
    expect(paths).toEqual(['agents/codex/auth.json']);
  });

  it('credits a race blob to the account the box left, puts the record`s back, and leaves a third login alone', async () => {
    const owned = (account: string, exp: number): string =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: exp,
          accountUuid: account,
        },
      });
    const workPath = join(dir, 'work.json');
    await writeFile(workPath, owned('w', 50));
    const repushes: string[] = [];
    const runs: string[] = [];
    const fanout = new CredentialsFanout({
      log: () => {},
      debounceMs: 100,
      runPropagate: async (agent, box, account) => void runs.push(`${agent}:${box}:${account}`),
      runRepush: async (agent, box, account) => void repushes.push(`${agent}:${box}:${account}`),
      // box-b and box-d left `work` 5 s ago; box-c switched long ago.
      lastSwitch: (box) =>
        Promise.resolve(
          box === 'box-c'
            ? { at: Date.now() - 3_600_000, from: 'work' }
            : box === 'box-a'
              ? undefined
              : { at: Date.now() - 5_000, from: 'work' },
        ),
      backupPathFor: (agent) => join(dir, `${agent}-credentials.json`),
      accountBackupPathFor: () => workPath,
      accountKindFor: () => Promise.resolve('login'),
      boxAccountFor: () => Promise.resolve(undefined),
    });
    expect((await fanout.handle('box-a', payload('claude', owned('me', 100)))).accepted).toBe(true);
    // work's refresh, written back after box-b moved to default.
    const r = await fanout.handle('box-b', payload('claude', owned('w', 200)));
    expect(r).toEqual({ accepted: false, reason: 'identity mismatch' });
    expect(await readFile(workPath, 'utf8')).toBe(owned('w', 200));
    expect(repushes).toEqual(['claude:box-b:default']);
    // Once a minute at most.
    await fanout.handle('box-b', payload('claude', owned('w', 300)));
    expect(repushes).toEqual(['claude:box-b:default']);
    // A login that is neither account's, right after a switch: a person's own /login.
    await fanout.handle('box-d', payload('claude', owned('someone', 400)));
    // Long after a switch, even the left account's login is left alone.
    await fanout.handle('box-c', payload('claude', owned('w', 500)));
    expect(repushes).toEqual(['claude:box-b:default']);
    expect(await readFile(workPath, 'utf8')).toBe(owned('w', 300));
    expect(await readFile(join(dir, 'claude-credentials.json'), 'utf8')).toBe(owned('me', 100));
    await fanout.flush();
    expect(runs).toEqual([]);
  });
});

describe('CredentialsFanout shares the credential lock with the hub import (#528 review)', () => {
  it('waits for a held lock, then gates against what the holder wrote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fanout-lock-'));
    try {
      const backup = join(dir, 'claude-credentials.json');
      await writeFile(backup, claudeBlob(100));
      const fanout = new CredentialsFanout({
        log: () => {},
        debounceMs: 10_000,
        runPropagate: async () => {},
        backupPathFor: () => backup,
        boxAccountFor: () => Promise.resolve(undefined),
      });
      const { withFileLock } = await import('@agentbox/config');
      let release!: () => void;
      const held = withFileLock(backup, async () => {
        await new Promise<void>((r) => (release = r));
        // An account import lands a newer login while holding the lock.
        await writeFile(backup, claudeBlob(900, 'imported'));
      });
      await new Promise((r) => setTimeout(r, 20));
      const pending = fanout.handle('box-a', payload('claude', claudeBlob(500, 'box')));
      await new Promise((r) => setTimeout(r, 50));
      release();
      await held;
      expect((await pending).accepted).toBe(false);
      expect(JSON.parse(await readFile(backup, 'utf8')).claudeAiOauth.expiresAt).toBe(900);
      await fanout.flush();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
