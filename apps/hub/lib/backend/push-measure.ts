// Measuring a push the hub's own git routes run: shared by the workspace
// timeline and the activity ledger, which both wrap those routes.
import { stat } from 'node:fs/promises';
import { sameMachineRef } from '@agentbox/config';
import {
  pushedRef,
  pushLineStat,
  readRefTip,
  type PushLineStat,
  type PushStatInput,
} from '@agentbox/relay';
import { hubMachine, type BackendDeps, type TimelineBoxFact } from './deps';

/** Where one push's stat is read from; see {@link pushStatSourceBefore}. */
export type PushStatSource =
  | { kind: 'host'; input: PushStatInput }
  | { kind: 'box'; boxId: string; before?: string };

/** How a push route addresses the host ref it moves. */
export interface PushTarget {
  remote?: string;
  hostOnly?: boolean;
  /** `push-host --as`: the local branch it lands on. */
  as?: string;
}

/** A folder on THIS machine, still there. A fact with no host names one here (Phase 1's rule). */
async function hostRepoHere(deps: BackendDeps, fact: TimelineBoxFact): Promise<boolean> {
  if (fact.host && !sameMachineRef(fact.host, hubMachine(deps))) return false;
  if (!fact.projectRoot) return false;
  return (await stat(fact.projectRoot).catch(() => null)) !== null;
}

/**
 * Where a push's stat comes from. The host repo when this hub holds it — the
 * ref's tip has to be read before the push moves it — else the box itself,
 * which is the only reader a control box has: its record of a box points at
 * the create job's temp clone, deleted long before the push.
 */
export async function pushStatSourceBefore(
  deps: BackendDeps,
  fact: TimelineBoxFact | undefined,
  push: PushTarget,
): Promise<PushStatSource | undefined> {
  const boxBranch = fact?.branches[0];
  if (!fact || !boxBranch) return undefined;
  if (await hostRepoHere(deps, fact)) {
    const branch = push.hostOnly && push.as ? push.as : boxBranch;
    const ref = pushedRef(branch, push);
    const before = await readRefTip(fact.projectRoot, ref);
    return {
      kind: 'host',
      input: { repo: fact.projectRoot, ref, branch, ...(before ? { before } : {}) },
    };
  }
  if (!deps.boxPushStat) return undefined;
  // Without the old tip the box measures from the default branch: the whole
  // branch, not this push. A host-only landing moves no ref in the box.
  const remote = push.remote ?? 'origin';
  const before =
    !push.hostOnly && /^[A-Za-z0-9._-]+$/u.test(remote)
      ? await deps
          .boxRefTip?.(fact.id, `refs/remotes/${remote}/${boxBranch}`)
          .catch(() => undefined)
      : undefined;
  return { kind: 'box', boxId: fact.id, ...(before ? { before } : {}) };
}

export function measurePush(
  deps: BackendDeps,
  src: PushStatSource,
): Promise<PushLineStat | undefined> {
  return src.kind === 'host'
    ? pushLineStat(src.input)
    : (deps.boxPushStat?.(src.boxId, src.before ? { before: src.before } : {}) ??
        Promise.resolve(undefined));
}
