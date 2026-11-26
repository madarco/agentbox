// One-time import of the workspace timelines into the ledger: the box
// lifecycle, pushes and PRs they hold go back to September, before the ledger
// existed. Only events older than the ledger itself are taken (anything later
// was written live), and a row's id is the timeline's dedupe key or its own id,
// so a rerun inserts nothing new.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoKey, STATE_DIR } from '@agentbox/config';
import type { TimelineEvent } from '../workspaces/types.js';
import {
  isActivityType,
  type ActivityEvent,
  type ActivityStore,
  type ActivityType,
} from './types.js';

export interface ActivityBackfillResult {
  workspaces: number;
  /** Timeline lines read. */
  read: number;
  /** Lines that became a ledger row candidate (the types the ledger keeps, before the cutoff). */
  mapped: number;
  inserted: number;
  byType: Partial<Record<ActivityType, number>>;
}

export interface ActivityBackfillOptions {
  /** The folder holding `<wsId>/timeline.jsonl` (default `~/.agentbox/workspaces`). */
  root?: string;
  /** Only events before this (epoch ms) are imported. Default: the ledger's `created_at`. */
  cutoffMs?: number;
}

interface WorkspaceProjectLite {
  id?: string;
  repoUrl?: string;
}

async function projectsOf(dir: string): Promise<WorkspaceProjectLite[]> {
  try {
    const rec = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')) as {
      projects?: WorkspaceProjectLite[];
    };
    return Array.isArray(rec.projects) ? rec.projects : [];
  } catch {
    return [];
  }
}

/**
 * The repo an event is about: its project's, else the PR's, else the
 * workspace's when it has exactly one repo (the common case).
 */
function repoUrlOf(
  ev: TimelineEvent,
  projects: readonly WorkspaceProjectLite[],
): string | undefined {
  const byId = ev.projectId ? projects.find((p) => p.id === ev.projectId)?.repoUrl : undefined;
  if (byId) return byId;
  if (ev.pr?.repo) {
    const match = projects.find((p) =>
      repoKey(p.repoUrl)?.endsWith(`/${ev.pr!.repo.toLowerCase()}`),
    );
    return match?.repoUrl ?? `https://github.com/${ev.pr.repo}`;
  }
  const repos = [...new Set(projects.map((p) => p.repoUrl).filter((u): u is string => !!u))];
  return repos.length === 1 ? repos[0] : undefined;
}

/** A timeline line as a ledger row; null for a type the ledger does not keep. */
export function activityFromTimeline(
  ev: TimelineEvent,
  wsId: string,
  projects: readonly WorkspaceProjectLite[] = [],
): ActivityEvent | null {
  if (!ev || typeof ev.type !== 'string' || !isActivityType(ev.type)) return null;
  if (typeof ev.at !== 'string' || Number.isNaN(Date.parse(ev.at))) return null;
  if (!ev.key && !ev.id) return null;
  const repoUrl = repoUrlOf(ev, projects);
  const projectKey = repoKey(repoUrl);
  const jobId = ev.key ? /^job:([^:]+):/u.exec(ev.key)?.[1] : undefined;
  return {
    id: ev.key ?? `tl:${ev.id}`,
    type: ev.type,
    at: ev.at,
    ...(ev.actor ? { actor: ev.actor } : {}),
    ...(ev.boxId ? { boxId: ev.boxId } : {}),
    ...(ev.boxName ? { boxName: ev.boxName } : {}),
    ...(ev.agent ? { agent: ev.agent } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(projectKey ? { projectKey } : {}),
    workspaceId: wsId,
    ...(ev.managerId ? { managerId: ev.managerId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(ev.branch ? { branch: ev.branch } : {}),
    ...(typeof ev.additions === 'number' ? { additions: ev.additions } : {}),
    ...(typeof ev.deletions === 'number' ? { deletions: ev.deletions } : {}),
    ...(ev.pr?.repo && typeof ev.pr.number === 'number'
      ? {
          pr: {
            repo: ev.pr.repo,
            number: ev.pr.number,
            ...(ev.pr.url ? { url: ev.pr.url } : {}),
          },
        }
      : {}),
    source: 'backfill',
  };
}

export async function backfillActivityFromTimelines(
  store: ActivityStore,
  opts: ActivityBackfillOptions = {},
): Promise<ActivityBackfillResult> {
  const root = opts.root ?? join(STATE_DIR, 'workspaces');
  const cutoff =
    opts.cutoffMs ?? Number((await store.getMeta('created_at')) ?? Number.POSITIVE_INFINITY);
  const result: ActivityBackfillResult = {
    workspaces: 0,
    read: 0,
    mapped: 0,
    inserted: 0,
    byType: {},
  };
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const rows: ActivityEvent[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    const text = await readFile(join(dir, 'timeline.jsonl'), 'utf8').catch(() => null);
    if (text === null) continue;
    result.workspaces += 1;
    const projects = await projectsOf(dir);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      result.read += 1;
      let ev: TimelineEvent;
      try {
        ev = JSON.parse(line) as TimelineEvent;
      } catch {
        continue;
      }
      const row = activityFromTimeline(ev, ent.name, projects);
      if (!row || Date.parse(row.at) >= cutoff) continue;
      rows.push(row);
      result.mapped += 1;
      result.byType[row.type] = (result.byType[row.type] ?? 0) + 1;
    }
  }
  result.inserted = await store.append(rows);
  return result;
}

const BACKFILL_DONE = 'timeline_backfill_at';

/**
 * Run the backfill once per ledger: the hub calls this at every start, and only
 * the first does any work. Rerunning by hand is safe anyway (ids dedupe).
 */
export async function ensureActivityBackfill(
  store: ActivityStore,
  opts: ActivityBackfillOptions = {},
): Promise<ActivityBackfillResult | null> {
  if (await store.getMeta(BACKFILL_DONE)) return null;
  const result = await backfillActivityFromTimelines(store, opts);
  await store.setMeta(BACKFILL_DONE, new Date().toISOString());
  return result;
}
