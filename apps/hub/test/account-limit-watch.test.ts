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
    runningBoxes: async () => [
      { id: 'b1', name: 'web', provider: 'docker', agents: ['claude'], owned: true },
    ],
    loginSwitchable: () => true,
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
    expect(limitKey(VIEWS[0]!)).toBe('2026-11-30T00:00:00.000Z');
  });

  it('skips a login the switch would refuse, so a later token is offered', () => {
    expect(nextAccount(VIEWS, 'claude', 'default', 'docker', false)?.id).toBe('tok');
  });

  it('a reset that drifts by seconds keeps its key', () => {
    const at = (t: string) =>
      view({ limits: { ...AT, windows: [{ id: 'w', label: 'W', pct: 100, resetsAt: t }] } });
    expect(limitKey(at('2026-11-30T00:00:04Z'))).toBe(limitKey(at('2026-11-29T23:59:57Z')));
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

  it('leaves boxes another PC registered alone', async () => {
    const d = deps({
      runningBoxes: async () => [
        { id: 'b1', name: 'web', provider: 'docker', agents: ['claude'], owned: false },
      ],
    });
    await createLimitWatch(d).tick();
    expect(d.switchAccount).not.toHaveBeenCalled();
  });

  it('ask: one approval per box and agent while it is open, even if the window moves', async () => {
    let answer!: (v: boolean) => void;
    let reset = '2026-11-30T00:00:00Z';
    const d = deps({
      onLimit: async () => 'ask',
      accounts: async () => [
        view({
          id: 'default',
          limits: { ...AT, windows: [{ ...AT.windows[0]!, resetsAt: reset }] },
        }),
        VIEWS[1]!,
        VIEWS[2]!,
      ],
      confirm: vi.fn(() => new Promise<boolean>((r) => (answer = r))),
    });
    const w = createLimitWatch(d);
    await w.tick();
    reset = '2026-12-07T00:00:00Z';
    await w.tick();
    expect(d.confirm).toHaveBeenCalledTimes(1);
    answer(false);
  });

  it('ask: on yes, re-picks the target as things are now', async () => {
    let answer!: (v: boolean) => void;
    let views = VIEWS;
    const d = deps({
      onLimit: async () => 'ask',
      accounts: async () => views,
      confirm: vi.fn(() => new Promise<boolean>((r) => (answer = r))),
    });
    await createLimitWatch(d).tick();
    // `work` hit its limit while the approval waited.
    views = [VIEWS[0]!, view({ id: 'work', limits: AT }), VIEWS[2]!];
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(d.switchAccount).toHaveBeenCalledWith('b1', {
      agent: 'claude',
      account: 'tok',
      reason: 'limit',
    });
  });

  it('ask: on yes, does nothing when the box left the limit meanwhile', async () => {
    let answer!: (v: boolean) => void;
    let views = VIEWS;
    const d = deps({
      onLimit: async () => 'ask',
      accounts: async () => views,
      confirm: vi.fn(() => new Promise<boolean>((r) => (answer = r))),
    });
    await createLimitWatch(d).tick();
    views = [view({ id: 'default' }), VIEWS[1]!, VIEWS[2]!];
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(d.switchAccount).not.toHaveBeenCalled();
  });
});
