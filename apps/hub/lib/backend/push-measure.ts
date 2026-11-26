// Measuring a push the hub's own git routes run: shared by the workspace
// timeline and the activity ledger, which both wrap those routes.
import { stat } from 'node:fs/promises';
import { sameMachineRef } from '@agentbox/config';
import {
  parsePushedTips,
  pushedRef,
  pushLineStat,
  type PushedTips,
  type PushLineStat,
} from '@agentbox/relay';
import { hubMachine, type BackendDeps, type TimelineBoxFact } from './deps';

/** How a push route addresses the host ref it moves. */
export interface PushTarget {
  remote?: string;
  hostOnly?: boolean;
  /** `push-host --as`: the local branch it lands on. */
  as?: string;
}

/** What one push route moved. */
export interface PushMeasure {
  /** Git printed no ref update: nothing was pushed or landed. */
  unmoved: boolean;
  tips?: PushedTips;
  diff?: PushLineStat;
}

/** A folder on THIS machine, still there. A fact with no host names one here (Phase 1's rule). */
async function hostRepoHere(deps: BackendDeps, fact: TimelineBoxFact): Promise<boolean> {
  if (fact.host && !sameMachineRef(fact.host, hubMachine(deps))) return false;
  if (!fact.projectRoot) return false;
  return (await stat(fact.projectRoot).catch(() => null)) !== null;
}

/** The branch a push route moves: the box's, or a host-only landing's `--as`. */
export function pushedBranch(fact: TimelineBoxFact, push: PushTarget): string | undefined {
  return push.hostOnly && push.as ? push.as : fact.branches[0];
}

async function measure(
  deps: BackendDeps,
  fact: TimelineBoxFact,
  push: PushTarget,
  output: string,
): Promise<PushMeasure> {
  const branch = pushedBranch(fact, push);
  const tips = branch ? parsePushedTips(output, branch) : undefined;
  if (!branch || !tips) return { unmoved: true };
  const before = tips.before ? { before: tips.before } : {};
  // The host repo when this hub holds it, else the box itself: the only reader a
  // control box has, since its record points at the create job's deleted clone.
  const diff = (await hostRepoHere(deps, fact))
    ? await pushLineStat({
        repo: fact.projectRoot,
        ref: pushedRef(branch, push),
        branch,
        ...before,
      })
    : await deps.boxPushStat?.(fact.id, before);
  return { unmoved: false, tips, ...(diff ? { diff } : {}) };
}

const measured = new WeakMap<object, Promise<PushMeasure>>();

/**
 * What a successful push route moved, from the ref update git printed (the
 * remote's own old and new tip), so nothing is read before the push. Measured
 * once per result: the timeline and the ledger wrap the same route and both
 * ask with the same result object.
 */
export function measurePushResult(
  deps: BackendDeps,
  fact: TimelineBoxFact,
  push: PushTarget,
  res: { stdout?: string; stderr?: string },
): Promise<PushMeasure> {
  let m = measured.get(res);
  if (!m) {
    m = measure(deps, fact, push, `${res.stderr ?? ''}\n${res.stdout ?? ''}`).catch(
      (): PushMeasure => ({ unmoved: false }),
    );
    measured.set(res, m);
  }
  return m;
}
