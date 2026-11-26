// The process-wide ledger seam. The hub and the queue worker open the store at
// start; everything else writes through `recordActivity`, which is a no-op when
// no ledger is configured (a test, a bare relay) and never throws: a row is
// written after the real work has answered, and a miss must not change it.
import { randomBytes } from 'node:crypto';
import { repoKey } from '@agentbox/config';
import { execa } from 'execa';
import { readState } from '@agentbox/sandbox-core';
import { managerIdForTarget } from '../workspaces/manager.js';
import { activityStoreFromSpec, activityStoreSpec } from './store.js';
import type { ActivityEvent, ActivityInput, ActivityStore } from './types.js';

let current: ActivityStore | null = null;

export function activityLedger(): ActivityStore | null {
  return current;
}

/** Install a store (`null` removes it). Returns what is now installed. */
export function configureActivityLedger(store: ActivityStore | null): ActivityStore | null {
  current = store;
  return current;
}

/**
 * Open the store this process's environment names, migrate it and install it.
 * Throws when it cannot be opened; a caller that can live without a ledger
 * catches and goes on.
 */
export async function openActivityLedger(
  spec: string | undefined = activityStoreSpec(),
): Promise<ActivityStore> {
  const store = activityStoreFromSpec(spec);
  await store.migrate();
  configureActivityLedger(store);
  return store;
}

/** What a writer that knows only a box id may not: its name, provider, agent, subscription, repo. */
export type ActivityBoxContext = Pick<
  ActivityEvent,
  'boxName' | 'provider' | 'agent' | 'account' | 'repoUrl' | 'managerId' | 'branch'
>;

export type ActivityBoxContextFn = (boxId: string) => Promise<ActivityBoxContext | undefined>;

/** The checkout's `origin`; undefined when the folder is gone (a worker's temp clone) or git is slow. */
async function originOf(root: string | undefined): Promise<string | undefined> {
  if (!root) return undefined;
  const r = await execa('git', ['-C', root, 'remote', 'get-url', 'origin'], {
    reject: false,
    timeout: 2000,
  }).catch(() => null);
  return r && r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

/**
 * The relay's own answer, from this machine's box records: no account (that is
 * the hub's rule, installed over this one) and no origin without a checkout.
 * The queue worker, a separate process, writes with this one.
 */
const recordContext: ActivityBoxContextFn = async (boxId) => {
  const box = (await readState().catch(() => null))?.boxes.find((b) => b.id === boxId);
  const managerId = await managerIdForTarget({ boxId }).catch(() => undefined);
  if (!box) return managerId ? { managerId } : undefined;
  const agent = box.lastAgent === 'claude-code' ? 'claude' : box.lastAgent;
  const repoUrl = await originOf(box.projectRoot);
  const branch =
    box.gitWorktrees?.[0]?.sanctionedBranch ??
    box.gitWorktrees?.[0]?.branch ??
    box.cloud?.sanctionedBranch ??
    box.cloud?.workspaceBranch;
  return {
    boxName: box.name,
    provider: box.provider ?? 'docker',
    ...(agent ? { agent } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(branch ? { branch } : {}),
    ...(managerId ? { managerId } : {}),
  };
};

let boxContext: ActivityBoxContextFn = recordContext;

/** The hub installs a richer reader (accounts, Store registrations); `null` restores the default. */
export function configureActivityBoxContext(fn: ActivityBoxContextFn | null): void {
  boxContext = fn ?? recordContext;
}

/** Time-sortable like a timeline id: base-36 ms, then a random suffix. */
export function newActivityId(ms: number = Date.now()): string {
  return `${ms.toString(36).padStart(9, '0')}-${randomBytes(4).toString('hex')}`;
}

/**
 * The row an input becomes: id and time filled, the box's context under what
 * the caller already said (a destroy reads the box before it is gone and passes
 * it in), and the project key derived from the repo.
 */
export async function activityEventOf(input: ActivityInput): Promise<ActivityEvent> {
  const ctx = input.boxId ? await boxContext(input.boxId).catch(() => undefined) : undefined;
  const merged = { ...stripUndefined(ctx ?? {}), ...stripUndefined(input), type: input.type };
  const at = merged.at ?? new Date().toISOString();
  const projectKey = repoKey(merged.repoUrl);
  return {
    ...merged,
    id: merged.id ?? newActivityId(Date.parse(at)),
    at,
    ...(projectKey ? { projectKey } : {}),
    source: 'live',
  } as ActivityEvent;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== '') (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Append one row through the installed ledger. Null when none is installed, the id is taken, or the write failed. */
export async function recordActivity(input: ActivityInput): Promise<ActivityEvent | null> {
  const store = current;
  if (!store) return null;
  try {
    const ev = await activityEventOf(input);
    return (await store.append([ev])) > 0 ? ev : null;
  } catch {
    return null;
  }
}
