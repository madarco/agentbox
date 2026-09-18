// A box's pull request for the box payload (`Box.pr`), read from the workspace
// timeline and the GitHub sync's in-memory PR states. `GET /boxes` is polled every
// few seconds, so each workspace's index is rebuilt only when its log file or
// the sync's states change.
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  listWorkspaces,
  readTimeline,
  resolveWorkspaceDir,
  timelineFile,
  workspaceForBox,
  type TimelineEvent,
  type WorkspaceRecord,
} from '@agentbox/relay';
import type { GithubPrSync } from './github-prs';
import type { Box, BoxPr } from '../boxes/types';

interface PrCandidate extends BoxPr {
  /** The PR's earliest logged event: which of two PRs on one branch is newer. */
  firstAt: string;
}

export interface WorkspacePrIndex {
  byBoxId: Map<string, PrCandidate[]>;
  byBranch: Map<string, PrCandidate[]>;
}

type PrStateOf = (repo: string, number: number) => BoxPr['state'] | undefined;

const STATE_OF_EVENT: Partial<Record<TimelineEvent['type'], BoxPr['state']>> = {
  'pr.opened': 'open',
  'pr.ready': 'ready',
  'pr.merged': 'merged',
  'pr.closed': 'closed',
};

/**
 * The log's own verdict, strongest first. The log cannot un-append, so a PR
 * logged ready and later closed is closed, and one merged is merged whatever
 * followed; a live state from the sync overrides this when there is one.
 */
const LOG_STATE_RANK: Record<BoxPr['state'], number> = { merged: 3, closed: 2, ready: 1, open: 0 };

function push(map: Map<string, PrCandidate[]>, key: string, pr: PrCandidate): void {
  const list = map.get(key);
  if (!list) map.set(key, [pr]);
  else if (!list.includes(pr)) list.push(pr);
}

export function indexTimelinePrs(events: TimelineEvent[], prState?: PrStateOf): WorkspacePrIndex {
  const prs = new Map<
    string,
    { pr: PrCandidate; logState: BoxPr['state']; boxIds: Set<string>; branches: Set<string> }
  >();
  for (const ev of events) {
    const state = STATE_OF_EVENT[ev.type];
    if (!state || !ev.pr?.repo || typeof ev.pr.number !== 'number') continue;
    const key = `${ev.pr.repo}#${String(ev.pr.number)}`;
    let row = prs.get(key);
    if (!row) {
      row = {
        pr: { repo: ev.pr.repo, number: ev.pr.number, state, firstAt: ev.at },
        logState: state,
        boxIds: new Set(),
        branches: new Set(),
      };
      prs.set(key, row);
    }
    if (ev.at < row.pr.firstAt) row.pr.firstAt = ev.at;
    if (LOG_STATE_RANK[state] > LOG_STATE_RANK[row.logState]) row.logState = state;
    if (ev.pr.url && !row.pr.url) row.pr.url = ev.pr.url;
    if (ev.boxId) row.boxIds.add(ev.boxId);
    if (ev.pr.head) row.branches.add(ev.pr.head);
    if (ev.branch) row.branches.add(ev.branch);
  }
  const index: WorkspacePrIndex = { byBoxId: new Map(), byBranch: new Map() };
  for (const row of prs.values()) {
    row.pr.state = prState?.(row.pr.repo, row.pr.number) ?? row.logState;
    for (const id of row.boxIds) push(index.byBoxId, id, row.pr);
    for (const br of row.branches) push(index.byBranch, br, row.pr);
  }
  return index;
}

function isActive(pr: BoxPr): boolean {
  return pr.state === 'open' || pr.state === 'ready';
}

/** An open PR over a merged or closed one (a branch reused after a merge), then the newest. */
export function pickBoxPr(candidates: readonly PrCandidate[]): BoxPr | undefined {
  let best: PrCandidate | undefined;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    if (isActive(c) !== isActive(best)) {
      if (isActive(c)) best = c;
      continue;
    }
    if (c.firstAt > best.firstAt || (c.firstAt === best.firstAt && c.number > best.number)) {
      best = c;
    }
  }
  if (!best) return undefined;
  return {
    repo: best.repo,
    number: best.number,
    ...(best.url ? { url: best.url } : {}),
    state: best.state,
  };
}

function branchesOf(box: Box): string[] {
  const out = new Set<string>();
  if (box.branch) out.add(box.branch);
  for (const wt of box.gitWorktrees ?? []) if (wt.branch) out.add(wt.branch);
  return [...out];
}

/**
 * Box ids are unique, so a box-id match is taken from any workspace. A branch
 * (`agentbox/<name>`) is not, so it matches only in the box's own workspace.
 */
export function prForBox(
  box: Box,
  indexes: ReadonlyMap<string, WorkspacePrIndex>,
  wsId: string | undefined,
): BoxPr | undefined {
  const byId: PrCandidate[] = [];
  for (const idx of indexes.values()) byId.push(...(idx.byBoxId.get(box.id) ?? []));
  if (byId.length) return pickBoxPr(byId);
  const idx = wsId ? indexes.get(wsId) : undefined;
  if (!idx) return undefined;
  const byBranch: PrCandidate[] = [];
  for (const br of branchesOf(box)) {
    for (const c of idx.byBranch.get(br) ?? []) if (!byBranch.includes(c)) byBranch.push(c);
  }
  return pickBoxPr(byBranch);
}

export type BoxPrOf = (box: Box) => BoxPr | undefined;

export interface BoxPrLookup {
  /** A sync lookup for one `getData()`. Never rejects: a workspace that cannot be read has no PRs. */
  resolver(wsByProject: ReadonlyMap<string, string>): Promise<BoxPrOf>;
}

export interface BoxPrLookupOptions {
  sync?: Pick<GithubPrSync, 'prState' | 'statesVersion'>;
  readEvents?: (wsId: string) => Promise<TimelineEvent[]>;
}

interface CacheEntry {
  stamp: string;
  index: WorkspacePrIndex;
}

const NONE: BoxPrOf = () => undefined;

export function createBoxPrLookup(opts: BoxPrLookupOptions = {}): BoxPrLookup {
  const readEvents = opts.readEvents ?? ((wsId: string) => readTimeline(wsId));
  const cache = new Map<string, CacheEntry>();

  async function indexOf(ws: WorkspaceRecord): Promise<WorkspacePrIndex | null> {
    const dir = await resolveWorkspaceDir(ws.id);
    if (!dir) return null;
    const st = await stat(timelineFile(dir)).catch(() => null);
    if (!st) {
      cache.delete(ws.id);
      return null;
    }
    const stamp = `${String(st.mtimeMs)}:${String(st.size)}:${String(opts.sync?.statesVersion() ?? 0)}`;
    const hit = cache.get(ws.id);
    if (hit?.stamp === stamp) return hit.index;
    const prState: PrStateOf | undefined = opts.sync
      ? (repo, n) => opts.sync!.prState(repo, n)
      : undefined;
    const index = indexTimelinePrs(await readEvents(ws.id), prState);
    cache.set(ws.id, { stamp, index });
    return index;
  }

  return {
    async resolver(wsByProject) {
      try {
        const records = await listWorkspaces();
        if (records.length === 0) {
          cache.clear();
          return NONE;
        }
        const indexes = new Map<string, WorkspacePrIndex>();
        await Promise.all(
          records.map(async (ws) => {
            const idx = await indexOf(ws).catch(() => null);
            if (idx) indexes.set(ws.id, idx);
          }),
        );
        const listed = new Set(records.map((r) => r.id));
        for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);
        if (indexes.size === 0) return NONE;
        const here = hostname();
        return (box) => {
          // Folder first, then the box's origin — the same join the timeline
          // writes its rows with, so a box with no checkout here (a cloud box,
          // or one built from a control box's throwaway clone) finds its PRs.
          const wsId =
            wsByProject.get(box.projectId) ??
            workspaceForBox(
              records,
              {
                ...(box.projectRoot ? { projectRoot: box.projectRoot } : {}),
                ...(box.originUrl ? { originUrl: box.originUrl } : {}),
              },
              here,
            )?.id;
          return prForBox(box, indexes, wsId);
        };
      } catch {
        return NONE;
      }
    },
  };
}
