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
