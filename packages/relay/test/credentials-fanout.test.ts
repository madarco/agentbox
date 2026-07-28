import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsFanout } from '../src/credentials-fanout.js';

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
    expect((await fanout.handle('box-b', payload('claude', claudeBlob(50, 'r2')))).accepted).toBe(false); // stale
    expect((await fanout.handle('box-b', payload('claude', claudeBlob(200, 'r3')))).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    await fanout.flush();
    // The two accepts within one debounce window collapse into one run.
    expect(runs).toEqual(['claude:box-b']);
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
});
