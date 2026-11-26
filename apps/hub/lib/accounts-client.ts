'use client';

// The hub's subscriptions as the web shows them (hub settings Phase 3b): one
// shared `GET /api/v1/accounts` poll for the top-bar meter, the sidebar's
// "at limit" count and the Subscriptions page, so a page with all three asks
// once. Polled every minute while the tab is visible; the hub itself reads a
// claude account's usage at most every 5 minutes, so polling faster buys
// nothing. Pure REST client.

import { useEffect, useSyncExternalStore } from 'react';
import type { AccountLimits, AccountLimitWindow } from '@/lib/boxes/backend-types';
import type { AccountKind } from '@/lib/subscriptions';

export type { AccountLimits, AccountLimitWindow as LimitWindow };

export interface Account {
  agent: string;
  id: string;
  label?: string;
  kind: AccountKind;
  identity?: { email?: string; org?: string; plan?: string };
  hasSecret: boolean;
  boxes: string[];
  limits?: AccountLimits;
  auth?: { state: 'ok' | 'expiring' | 'revoked'; since?: string; box?: string; detail?: string };
  /** `global`: the agent's default for new boxes (its own login when none is set). */
  default?: { global?: boolean; project?: boolean };
}

export interface AgentKinds {
  id: string;
  kinds: AccountKind[];
}

export interface AccountsSnapshot {
  accounts: Account[] | null;
  agents: AgentKinds[];
  error: string | null;
}

const POLL_MS = 60_000;
let snapshot: AccountsSnapshot = { accounts: null, agents: [], error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let queued: Promise<void> | null = null;
let users = 0;

function emit(next: AccountsSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

/**
 * Fetch now (after an add, a label or a remove). A call made while a request
 * is in flight queues one more after it: the running one may have started
 * before the change and would answer with the old list.
 */
export function refreshAccounts(): Promise<void> {
  if (inflight) {
    queued ??= inflight.then(() => {
      queued = null;
      return refreshAccounts();
    });
    return queued;
  }
  inflight = (async () => {
    try {
      const r = await fetch('/api/v1/accounts', { credentials: 'same-origin' });
      const body = (await r.json().catch(() => ({}))) as {
        accounts?: Account[];
        agents?: AgentKinds[];
        error?: { message?: string };
      };
      if (!r.ok) throw new Error(body.error?.message ?? `request failed (${String(r.status)})`);
      emit({ accounts: body.accounts ?? [], agents: body.agents ?? [], error: null });
    } catch (err) {
      emit({ ...snapshot, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const SERVER: AccountsSnapshot = { accounts: null, agents: [], error: null };

export function useAccounts(): AccountsSnapshot {
  useEffect(() => {
    users++;
    if (users === 1) {
      void refreshAccounts();
      timer = setInterval(() => {
        if (!document.hidden) void refreshAccounts();
      }, POLL_MS);
    }
    return () => {
      users--;
      if (users === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => SERVER,
  );
}

/** The highest window's percent: how close the account is to any limit. */
export function topPct(a: Pick<Account, 'limits'>): number {
  return Math.max(0, ...(a.limits?.windows.map((w) => w.pct) ?? []));
}

/** In-use subscriptions, most constrained first (no data last). */
export function rankInUse(accounts: readonly Account[]): Account[] {
  return accounts
    .filter((a) => a.boxes.length > 0)
    .sort(
      (x, y) =>
        Number(Boolean(y.limits)) - Number(Boolean(x.limits)) ||
        Number(y.limits?.atLimit ?? false) - Number(x.limits?.atLimit ?? false) ||
        topPct(y) - topPct(x),
    );
}

/** `resets Mon 9:00`, `resets in 3 h`, from an ISO time. */
export function resetText(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const ms = t - now;
  if (ms <= 0) return 'resets now';
  if (ms < 60 * 60_000) return `resets in ${String(Math.max(1, Math.round(ms / 60_000)))} min`;
  if (ms < 12 * 60 * 60_000) return `resets in ${String(Math.round(ms / 3_600_000))} h`;
  const d = new Date(t);
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `resets ${day} ${time}`;
}

/** `updated 2 min ago`. */
export function agoText(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'updated just now';
  if (ms < 60 * 60_000) return `updated ${String(Math.round(ms / 60_000))} min ago`;
  if (ms < 48 * 60 * 60_000) return `updated ${String(Math.round(ms / 3_600_000))} h ago`;
  return `updated ${String(Math.round(ms / 86_400_000))} days ago`;
}
