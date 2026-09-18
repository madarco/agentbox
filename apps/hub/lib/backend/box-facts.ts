// The box seams the timeline reads (`BackendDeps.boxFacts` / `boxFact` /
// `boxDiffStat`), built from the host's box records. Kept out of
// `hub-backend.ts`, which only hands in the functions it owns.
import { hostname as osHostname } from 'node:os';
import { hashProjectPath } from '@agentbox/config';
import type { BoxRecord, Provider } from '@agentbox/core';
import { BOX_WORKSPACE } from '@agentbox/sandbox-core';
import type { ListedBox } from '@agentbox/sandbox-docker';
import type { DiffStat, TimelineBoxFact } from './deps';
import { parseShortstat } from './timeline';

export interface BoxFactSources {
  listBoxes(): Promise<ListedBox[]>;
  /** The persisted record for one box (`state.json`), with no per-box probing. */
  readBoxRecord(id: string): Promise<BoxRecord | undefined>;
  providerForBox(box: BoxRecord): Promise<Provider>;
  /**
   * The box repo's `origin`: `git remote` in its host checkout, or the box's
   * Store registration when there is no checkout here. Absent in a test, where
   * the folder join is the only one exercised.
   */
  originUrlOf?(box: BoxRecord): Promise<string | undefined>;
  hostname?(): string;
}

const STATE_PROBE_TIMEOUT_MS = 3000;

export function boxFactOf(
  b: BoxRecord & { state?: string },
  extra: { originUrl?: string; host?: string } = {},
): TimelineBoxFact {
  const root = b.projectRoot ?? b.workspacePath ?? b.id;
  const tree = b.gitWorktrees?.[0];
  const branches = [
    tree?.sanctionedBranch,
    tree?.branch,
    b.cloud?.sanctionedBranch,
    b.cloud?.workspaceBranch,
  ].filter((x): x is string => Boolean(x));
  const agent = b.lastAgent === 'claude-code' ? 'claude' : b.lastAgent;
  return {
    id: b.id,
    name: b.name,
    branches: [...new Set(branches)],
    ...(b.state ? { state: b.state } : {}),
    ...(agent ? { agent } : {}),
    projectRoot: root,
    projectId: hashProjectPath(root),
    ...(extra.originUrl ? { originUrl: extra.originUrl } : {}),
    ...(extra.host ? { host: extra.host } : {}),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

export function createBoxFactSeams(src: BoxFactSources): {
  boxFacts(): Promise<TimelineBoxFact[]>;
  boxFact(id: string, opts?: { withState?: boolean }): Promise<TimelineBoxFact | undefined>;
  boxDiffStat(box: TimelineBoxFact): Promise<DiffStat | null>;
} {
  // The record a fact was built from, so a diff of a box that was just listed
  // does not list the whole fleet again to find it.
  const recordOf = new WeakMap<TimelineBoxFact, BoxRecord>();
  const remember = (fact: TimelineBoxFact, rec: BoxRecord): TimelineBoxFact => {
    recordOf.set(fact, rec);
    return fact;
  };
  const host = src.hostname ?? osHostname;
  // Resolving an origin spawns git (or reads the Store), and `boxFacts()` runs on
  // the timeline poll path for the whole fleet: memoized per box, since a box's
  // repo does not change under it.
  //
  // Only a RESOLVED origin is kept. A miss — the checkout is not there yet, git
  // failed, the registration has not been written — is transient, and caching it
  // for the hub's lifetime left the box unable to join its workspace by repo
  // until someone restarted the hub.
  const origins = new Map<string, Promise<string | undefined>>();
  const originOf = (rec: BoxRecord): Promise<string | undefined> => {
    if (!src.originUrlOf) return Promise.resolve(undefined);
    let hit = origins.get(rec.id);
    if (!hit) {
      hit = src.originUrlOf(rec).catch(() => undefined);
      origins.set(rec.id, hit);
      // Kept only while it is in flight, so one listing still resolves it once.
      void hit.then((url) => {
        if (!url) origins.delete(rec.id);
      });
    }
    return hit;
  };
  const factOf = async (
    rec: BoxRecord & { state?: string },
    source: BoxRecord,
  ): Promise<TimelineBoxFact> => {
    const originUrl = await originOf(source);
    return remember(boxFactOf(rec, { host: host(), ...(originUrl ? { originUrl } : {}) }), source);
  };
  return {
    async boxFacts() {
      return Promise.all((await src.listBoxes()).map((b) => factOf(b, b)));
    },
    async boxFact(id, opts) {
      const rec = await src.readBoxRecord(id);
      if (!rec) return undefined;
      let state: string | undefined;
      if (opts?.withState) {
        state =
          rec.provider && rec.provider !== 'docker'
            ? rec.cloud?.lastState
            : await withTimeout(
                src.providerForBox(rec).then((p) => p.probeState(rec)),
                STATE_PROBE_TIMEOUT_MS,
              );
      }
      return factOf(state ? { ...rec, state } : rec, rec);
    },
    async boxDiffStat(fact) {
      const box = recordOf.get(fact) ?? (await src.readBoxRecord(fact.id));
      if (!box) return null;
      const provider = await src.providerForBox(box);
      const r = await provider.exec(box, ['git', 'diff', '--shortstat'], { cwd: BOX_WORKSPACE });
      return r.exitCode === 0 ? parseShortstat(r.stdout) : null;
    },
  };
}
