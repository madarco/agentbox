import { describe, expect, it } from 'vitest';
import { createHistoryService, type HistoryRepo } from '../lib/backend/history';

describe('refreshUsageSpans', () => {
  it('a call arriving mid-run waits for one more round, so turns it brings are refreshed', async () => {
    let calls = 0;
    let release!: () => void;
    const first = new Promise<void>((r) => {
      release = r;
    });
    const repo = {
      refreshSpans: async () => {
        calls++;
        if (calls === 1) await first;
        return 0;
      },
    } as unknown as HistoryRepo;
    const svc = createHistoryService({ repo, archive: {} as never, retentionDays: 90 });
    const a = svc.refreshUsageSpans();
    const b = svc.refreshUsageSpans(); // a final flush landing while `a` runs
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(2);
    // Idle again: a new call runs right away.
    await svc.refreshUsageSpans();
    expect(calls).toBe(3);
  });
});

describe('rawStream from an offset', () => {
  it('starts at the chunk holding the offset and never reads the ones before', async () => {
    const { gzipSync } = await import('node:zlib');
    const parts = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'];
    const got: string[] = [];
    let start = 0;
    const chunks = parts.map((p, i) => {
      const c = {
        id: i + 1,
        fileId: 1,
        generation: 0,
        start,
        end: start + p.length,
        key: `k${String(i)}`,
        codec: 'gzip' as const,
        sealed: false,
        deduped: false,
        endsWithNewline: true,
        storedBytes: 0,
      };
      start += p.length;
      return c;
    });
    const repo = {
      getFileById: async () => ({ id: 1, generation: 0, offset: start }),
      listChunks: async () => chunks,
    } as unknown as HistoryRepo;
    const archive = {
      get: async (key: string) => {
        got.push(key);
        return gzipSync(Buffer.from(parts[Number(key.slice(1))]!));
      },
    };
    const svc = createHistoryService({ repo, archive: archive as never, retentionDays: 90 });
    const out: Buffer[] = [];
    for await (const b of svc.rawStream(1, undefined, 11)) out.push(b);
    expect(Buffer.concat(out).toString()).toBe('":2}\n{"c":3}\n');
    expect(got).toEqual(['k1', 'k2']);
  });
});
