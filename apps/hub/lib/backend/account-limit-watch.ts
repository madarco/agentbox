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
}

export interface LimitWatchDeps {
  onLimit(): Promise<OnLimit>;
  accounts(): Promise<AccountView[]>;
  /** The boxes running right now. */
  runningBoxes(): Promise<WatchedBox[]>;
  /** Ask a person; resolves true on yes. */
  confirm(boxId: string, message: string, detail: string): Promise<boolean>;
  switchAccount(boxId: string, req: SwitchRequest): Promise<SwitchResult>;
  log(line: string): void;
}

/** The earliest reset of the windows at their limit, or '' when none says. Pure. */
export function limitKey(view: Pick<AccountView, 'limits'>): string {
  const resets = (view.limits?.windows ?? [])
    .filter((w) => w.pct >= 100 && w.resetsAt)
    .map((w) => w.resetsAt as string)
    .sort();
  return resets[0] ?? '';
}

function usableAtLimit(v: AccountView): boolean {
  return Boolean(v.limits?.atLimit && !v.limits.stale);
}

/**
 * The account to move `agent` to: the same agent's accounts in store order,
 * not the current one, not at its limit, usable by this box (a token needs its
 * secret; a login needs a docker box). Pure.
 */
export function nextAccount(
  views: readonly AccountView[],
  agent: string,
  current: string,
  provider: string,
): AccountView | undefined {
  return views.find(
    (v) =>
      v.agent === agent &&
      v.id !== current &&
      !v.limits?.atLimit &&
      (v.kind === 'login' ? provider === 'docker' : v.hasSecret),
  );
}

export function createLimitWatch(deps: LimitWatchDeps): {
  tick(): Promise<void>;
} {
  const handled = new Set<string>();
  const asking = new Set<string>();

  return {
    async tick() {
      const views = await deps.accounts().catch(() => [] as AccountView[]);
      if (!views.some(usableAtLimit)) return;
      const mode = await deps.onLimit().catch(() => 'ask' as OnLimit);
      const boxes = await deps.runningBoxes().catch(() => [] as WatchedBox[]);
      for (const box of boxes) {
        for (const agent of box.agents) {
          const current = box.accounts?.[agent] ?? 'default';
          const view = views.find((v) => v.agent === agent && v.id === current);
          if (!view || !usableAtLimit(view)) continue;
          const key = `${box.id}|${agent}|${current}|${limitKey(view)}`;
          if (handled.has(key) || asking.has(key)) continue;
          const next = nextAccount(views, agent, current, box.provider);
          if (!next) {
            handled.add(key);
            deps.log(
              `${box.name}: ${agent} account '${current}' is at its limit and no other account is available`,
            );
            continue;
          }
          const run = async (): Promise<void> => {
            const r = await deps.switchAccount(box.id, {
              agent,
              account: next.id,
              reason: 'limit',
            });
            deps.log(
              r.kind === 'ok'
                ? `${box.name}: ${agent} moved from '${current}' (at its limit) to '${next.id}'`
                : `${box.name}: switching ${agent} to '${next.id}' failed: ${'error' in r ? r.error : r.kind}`,
            );
          };
          if (mode === 'switch') {
            handled.add(key);
            await run();
            continue;
          }
          // `ask`: the approval waits for an answer; the tick does not.
          asking.add(key);
          const reset = limitKey(view);
          void deps
            .confirm(
              box.id,
              `${box.name} is at the limit on ${agent}/${current}: switch to ${next.id}?`,
              [
                reset ? `The limit resets ${new Date(reset).toLocaleString()}.` : '',
                next.kind === 'login' && box.provider === 'docker'
                  ? 'The box is rebuilt on that login; the conversation resumes.'
                  : 'The agent restarts on that account; the conversation resumes.',
              ]
                .filter(Boolean)
                .join(' '),
            )
            .then(async (yes) => {
              if (yes) await run();
            })
            .catch((err: unknown) => {
              deps.log(`${box.name}: limit approval failed: ${String(err)}`);
            })
            .finally(() => {
              asking.delete(key);
              handled.add(key);
            });
        }
      }
    },
  };
}
