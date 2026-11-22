// GitHub pull requests as timeline events. Shared by the in-box `gh` shim hook
// (relay) and the hub's GitHub sync, so both derive the same dedupe keys and a
// PR reported by either path lands in the log once.
import { repoKey } from '@agentbox/config';
import type { TimelineChecks, TimelinePr } from './types.js';
import type { TimelineEventInput } from './timeline-store.js';

/** The `gh pr list/view --json` fields the timeline reads. */
export const GH_PR_JSON_FIELDS = [
  'number',
  'title',
  'url',
  'headRefName',
  'baseRefName',
  'state',
  'mergedAt',
  'closedAt',
  'createdAt',
  'additions',
  'deletions',
  'statusCheckRollup',
  'mergeStateStatus',
  'autoMergeRequest',
  'mergedBy',
  'author',
].join(',');

export interface GhPrJson {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | string;
  mergedAt?: string | null;
  closedAt?: string | null;
  createdAt?: string | null;
  additions?: number;
  deletions?: number;
  statusCheckRollup?: {
    status?: string;
    conclusion?: string | null;
    state?: string;
  }[];
  mergeStateStatus?: string;
  autoMergeRequest?: unknown;
  mergedBy?: { login?: string } | null;
  author?: { login?: string } | null;
}

export type PrEventKind = 'opened' | 'ready' | 'merged' | 'closed';

export function prEventKey(repo: string, number: number, kind: PrEventKind): string {
  return `pr:${repo}#${String(number)}:${kind}`;
}

/** `https://<host>/<owner>/<repo>/pull/<n>` → `{repo: 'owner/repo', number}`. */
export function parsePrUrl(url: string): { repo: string; number: number; url: string } | null {
  const m = /https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/u.exec(url);
  if (!m) return null;
  return { repo: `${m[1]!}/${m[2]!}`, number: Number(m[3]), url: m[0] };
}

const FAILED = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Collapse a check rollup (CheckRuns and commit StatusContexts mixed) to one verdict. */
export function checksOf(rollup: GhPrJson['statusCheckRollup']): TimelineChecks {
  if (!rollup || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const verdict = (c.conclusion ?? c.state ?? '').toUpperCase();
    if (FAILED.has(verdict)) return 'fail';
    if (c.status && c.status.toUpperCase() !== 'COMPLETED') pending = true;
    else if (!PASSED.has(verdict)) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

/** Open, green, and mergeable as-is: what the timeline shows as "ready to merge". */
export function isPrReady(pr: GhPrJson): boolean {
  if (pr.state !== 'OPEN') return false;
  if (checksOf(pr.statusCheckRollup) !== 'pass') return false;
  return pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'HAS_HOOKS';
}

export function timelinePrOf(pr: GhPrJson, repo: string): TimelinePr {
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    base: pr.baseRefName,
    head: pr.headRefName,
    ...(typeof pr.additions === 'number' ? { additions: pr.additions } : {}),
    ...(typeof pr.deletions === 'number' ? { deletions: pr.deletions } : {}),
    checks: checksOf(pr.statusCheckRollup),
    ...(pr.mergeStateStatus ? { mergeState: pr.mergeStateStatus } : {}),
    autoMerge: Boolean(pr.autoMergeRequest),
    ...(pr.mergedBy?.login ? { mergedBy: pr.mergedBy.login } : {}),
  };
}

/**
 * Every event a PR's current state implies, each with its dedupe key. Appending
 * all of them on every sync is correct: the keys make the repeats no-ops.
 * `nowIso` stamps `pr.ready`, which GitHub records no time for.
 */
export function prTimelineEvents(
  pr: GhPrJson,
  repo: string,
  base: Omit<TimelineEventInput, 'type' | 'pr' | 'key' | 'at'>,
  nowIso: string = new Date().toISOString(),
): TimelineEventInput[] {
  const tpr = timelinePrOf(pr, repo);
  const common = { ...base, branch: base.branch ?? pr.headRefName, pr: tpr };
  const out: TimelineEventInput[] = [
    {
      ...common,
      type: 'pr.opened',
      at: pr.createdAt ?? nowIso,
      key: prEventKey(repo, pr.number, 'opened'),
    },
  ];
  if (pr.state === 'MERGED') {
    out.push({
      ...common,
      type: 'pr.merged',
      at: pr.mergedAt ?? nowIso,
      key: prEventKey(repo, pr.number, 'merged'),
    });
  } else if (pr.state === 'CLOSED') {
    out.push({
      ...common,
      type: 'pr.closed',
      at: pr.closedAt ?? nowIso,
      key: prEventKey(repo, pr.number, 'closed'),
    });
  } else if (isPrReady(pr)) {
    out.push({
      ...common,
      type: 'pr.ready',
      at: nowIso,
      key: prEventKey(repo, pr.number, 'ready'),
    });
  }
  return out;
}

/**
 * What `gh repo view` takes for a repo URL, with no folder to read it from:
 * `owner/name` on github.com, `HOST/owner/name` anywhere else (which is what
 * `gh` wants for an Enterprise host, and what a non-GitHub host fails on).
 *
 * Undefined when the URL names no repo of that shape — a local path, a deeper
 * path than `owner/name`. Lowercased by the normalisation, which is safe: git
 * hosts treat owner/repo case-insensitively and `gh` answers with the canonical
 * spelling.
 */
export function ghRepoArg(repoUrl: string | undefined | null): string | undefined {
  const key = repoKey(repoUrl);
  if (!key) return undefined;
  const [host, owner, name, ...rest] = key.split('/');
  if (!host || !owner || !name || rest.length > 0) return undefined;
  return host === 'github.com' ? `${owner}/${name}` : key;
}

