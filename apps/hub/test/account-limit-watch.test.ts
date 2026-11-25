import { describe, expect, it, vi } from 'vitest';
import type { AccountView } from '../lib/boxes/backend-types';
import {
  createLimitWatch,
  limitKey,
  nextAccount,
  type LimitWatchDeps,
} from '../lib/backend/account-limit-watch';

const AT = {
  windows: [{ id: 'w', label: 'Weekly', pct: 100, resetsAt: '2026-11-30T00:00:00Z' }],
  atLimit: true,
  updatedAt: '2026-11-25T00:00:00Z',
  source: 'usage-api' as const,
};
const view = (o: Partial<AccountView>): AccountView =>
  ({
    agent: 'claude',
    id: 'default',
    kind: 'login',
    hasSecret: false,
    boxes: [],
    ...o,
  }) as AccountView;

const VIEWS = [
  view({ id: 'default', limits: AT }),
  view({ id: 'work', kind: 'login' }),
  view({ id: 'tok', kind: 'setup-token', hasSecret: true }),
];

function deps(o: Partial<LimitWatchDeps> = {}) {
  const d: LimitWatchDeps = {
    onLimit: async () => 'switch',
    accounts: async () => VIEWS,
    runningBoxes: async () => [{ id: 'b1', name: 'web', provider: 'docker', agents: ['claude'] }],
    confirm: vi.fn(async () => true),
    switchAccount: vi.fn(async () => ({ kind: 'ok' }) as never),
    log: () => {},
    ...o,
  };
  return d;
}

describe('nextAccount', () => {
  it('skips the current one and logins on a cloud box', () => {
    expect(nextAccount(VIEWS, 'claude', 'default', 'docker')?.id).toBe('work');
    expect(nextAccount(VIEWS, 'claude', 'default', 'hetzner')?.id).toBe('tok');
    expect(limitKey(VIEWS[0]!)).toBe('2026-11-30T00:00:00Z');
  });
});

describe('createLimitWatch', () => {
  it('switch: moves the box once per window', async () => {
    const d = deps();
    const w = createLimitWatch(d);
    await w.tick();
    await w.tick();
    expect(d.switchAccount).toHaveBeenCalledTimes(1);
    expect(d.switchAccount).toHaveBeenCalledWith('b1', {
      agent: 'claude',
      account: 'work',
      reason: 'limit',
    });
  });

  it('ask: raises one approval and switches on yes', async () => {
    const d = deps({ onLimit: async () => 'ask' });
    const w = createLimitWatch(d);
    await w.tick();
    await w.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.confirm).mock.calls[0]?.[1]).toBe(
      'web is at the limit on claude/default: switch to work?',
    );
    expect(d.switchAccount).toHaveBeenCalledTimes(1);
  });

  it('ask: a no is not asked again in the same window', async () => {
    const d = deps({ onLimit: async () => 'ask', confirm: vi.fn(async () => false) });
    const w = createLimitWatch(d);
    await w.tick();
    await new Promise((r) => setTimeout(r, 0));
    await w.tick();
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.switchAccount).not.toHaveBeenCalled();
  });

  it('ignores stale limits and boxes not at the limit', async () => {
    const d = deps({
      accounts: async () => [view({ id: 'default', limits: { ...AT, stale: true } }), VIEWS[1]!],
    });
    await createLimitWatch(d).tick();
    expect(d.switchAccount).not.toHaveBeenCalled();
  });
});
