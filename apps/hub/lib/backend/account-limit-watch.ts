// `accounts.onLimit` (hub settings 3c): when a running box's agent is on an
// account at its plan limit, offer to switch it to the next account of the
// same agent that is not (`ask`, a host approval answered in the web, the tray
// or the CLI), or switch it outright (`switch`).
//
// The trigger is the account's `atLimit` from its limits (3b); stale limits do
// not count. Each (box, agent, account, reset time) is acted on once: a refused
// approval is not raised again until the window resets or the box moves.
import type { AccountView } from '../boxes/backend-types';
import type { SwitchRequest, SwitchResult } from './account-switch';

export type OnLimit = 'ask' | 'switch';

export interface WatchedBox {
  id: string;
  name: string;
  provider: string;
  /** The agents the box runs. */
  agents: string[];
  accounts?: Record<string, string>;
  /**
   * The box is this hub's own (in its state), not one another PC registered:
   * only its own boxes are moved, the others are their PC's to decide.
   */
  owned: boolean;
}

export interface LimitWatchDeps {
  onLimit(): Promise<OnLimit>;
  accounts(): Promise<AccountView[]>;
  /** The boxes running right now. */
  runningBoxes(): Promise<WatchedBox[]>;
  /** An agent whose box can be switched to a login (its session files are known). */
  loginSwitchable(agent: string): boolean;
  /** Ask a person; resolves true on yes. */
  confirm(boxId: string, message: string, detail: string): Promise<boolean>;
  switchAccount(boxId: string, req: SwitchRequest): Promise<SwitchResult>;
  log(line: string): void;
}

/**
 * The earliest reset of the windows at their limit, to the quarter hour (a
 * codex reset is derived from "resets in N seconds" and drifts), or '' when
 * none says. Pure.
 */
export function limitKey(view: Pick<AccountView, 'limits'>): string {
  const resets = (view.limits?.windows ?? [])
    .filter((w) => w.pct >= 100 && w.resetsAt)
    .map((w) => Date.parse(w.resetsAt as string))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (resets.length === 0) return '';
  const q = 15 * 60_000;
  return new Date(Math.round(resets[0]! / q) * q).toISOString();
}

function usableAtLimit(v: AccountView): boolean {
  return Boolean(v.limits?.atLimit && !v.limits.stale);
}

/**
 * The account to move `agent` to: the same agent's accounts in store order,
 * not the current one, not at its limit, one the switch would accept for this
 * box (a token needs its secret; a login needs a docker box and an agent whose
 * login switch is supported). Pure.
 */
export function nextAccount(
  views: readonly AccountView[],
  agent: string,
  current: string,
  provider: string,
  loginSwitchable = true,
): AccountView | undefined {
  return views.find(
    (v) =>
      v.agent === agent &&
      v.id !== current &&
      !v.limits?.atLimit &&
      (v.kind === 'login' ? provider === 'docker' && loginSwitchable : v.hasSecret),
  );
}

export function createLimitWatch(deps: LimitWatchDeps): {
  tick(): Promise<void>;
} {
  /** (box, agent, account, limit window) already acted on. */
  const handled = new Set<string>();
  /** (box, agent) with an approval open: one at a time, whatever the window does. */
  const asking = new Set<string>();

  /** The box, its account, and the target, as they are now; undefined when it no longer applies. */
  const plan = (
    views: readonly AccountView[],
    box: WatchedBox,
    agent: string,
  ): { current: string; view: AccountView; next: AccountView | undefined } | undefined => {
    const current = box.accounts?.[agent] ?? 'default';
    const view = views.find((v) => v.agent === agent && v.id === current);
    if (!view || !usableAtLimit(view)) return undefined;
    const next = nextAccount(views, agent, current, box.provider, deps.loginSwitchable(agent));
    return { current, view, next };
  };

  const run = async (box: WatchedBox, agent: string, current: string, to: string) => {
    const r = await deps.switchAccount(box.id, { agent, account: to, reason: 'limit' });
    deps.log(
      r.kind === 'ok'
        ? `${box.name}: ${agent} moved from '${current}' (at its limit) to '${to}'`
        : `${box.name}: switching ${agent} to '${to}' failed: ${'error' in r ? r.error : r.kind}`,
    );
  };

  return {
    async tick() {
      const views = await deps.accounts().catch(() => [] as AccountView[]);
      if (!views.some(usableAtLimit)) return;
      const mode = await deps.onLimit().catch(() => 'ask' as OnLimit);
      const boxes = (await deps.runningBoxes().catch(() => [] as WatchedBox[])).filter(
        (b) => b.owned,
      );
      const live = new Set<string>();
      for (const box of boxes) {
        for (const agent of box.agents) {
          const p = plan(views, box, agent);
          if (!p) continue;
          const key = `${box.id}|${agent}|${p.current}|${limitKey(p.view)}`;
          live.add(key);
          const askKey = `${box.id}|${agent}`;
          if (handled.has(key) || asking.has(askKey)) continue;
          if (!p.next) {
            handled.add(key);
            deps.log(
              `${box.name}: ${agent} account '${p.current}' is at its limit and no other account is available`,
            );
            continue;
          }
          if (mode === 'switch') {
            handled.add(key);
            await run(box, agent, p.current, p.next.id);
            continue;
          }
          // `ask`: the approval waits for an answer; the tick does not.
          asking.add(askKey);
          const reset = limitKey(p.view);
          const asked = p.next;
          void deps
            .confirm(
              box.id,
              `${box.name} is at the limit on ${agent}/${p.current}: switch to ${asked.id}?`,
              [
                reset ? `The limit resets around ${new Date(reset).toLocaleString()}.` : '',
                asked.kind === 'login' && box.provider === 'docker'
                  ? 'The box is rebuilt on that login; the conversation resumes.'
                  : 'The agent restarts on that account; the conversation resumes.',
              ]
                .filter(Boolean)
                .join(' '),
            )
            .then(async (yes) => {
              if (!yes) return;
              // Things moved while the approval waited: act on them as they are now.
              const nowViews = await deps.accounts();
              const nowBox = (await deps.runningBoxes()).find((b) => b.id === box.id && b.owned);
              const now = nowBox ? plan(nowViews, nowBox, agent) : undefined;
              if (!nowBox || !now || now.current !== p.current) {
                deps.log(
                  `${box.name}: ${agent} is no longer at its limit on '${p.current}'; nothing to switch`,
                );
                return;
              }
              if (!now.next) {
                deps.log(`${box.name}: no other ${agent} account is available any more`);
                return;
              }
              await run(nowBox, agent, now.current, now.next.id);
            })
            .catch((err: unknown) => {
              deps.log(`${box.name}: limit approval failed: ${String(err)}`);
            })
            .finally(() => {
              asking.delete(askKey);
              handled.add(key);
            });
        }
      }
      // A key leaves once its box is no longer at that limit (it moved, the
      // window reset, it stopped), so the set stays as small as the fleet.
      for (const k of handled) if (!live.has(k)) handled.delete(k);
    },
  };
}
