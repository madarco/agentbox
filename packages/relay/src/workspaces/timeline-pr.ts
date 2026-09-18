// GitHub pull requests as timeline events. Shared by the in-box `gh` shim hook
// (relay) and the hub's GitHub sync, so both derive the same dedupe keys and a
// PR reported by either path lands in the log once.
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
 * One key for every spelling of a single repo, so a box's `origin` and a
 * workspace project's `repoUrl` join without caring how each was written:
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo`,
 * `ssh://git@github.com/owner/repo/` all become `github.com/owner/repo`.
 *
 * Lowercased whole: git hosts treat owner/repo case-insensitively, and the same
 * repo routinely appears in both spellings across a fleet. A local path origin
 * keeps its path (it is still a usable key, just a host-local one); an empty or
 * unparseable value yields undefined, which never matches anything.
 */
export function normalizeRepoUrl(raw: string | undefined | null): string | undefined {
  const url = (raw ?? '').trim();
  if (!url) return undefined;
  const strip = (s: string): string => {
    let out = s;
    while (out.endsWith('/')) out = out.slice(0, -1);
    if (out.endsWith('.git')) out = out.slice(0, -'.git'.length);
    return out.toLowerCase();
  };
  if (url.startsWith('/')) return strip(url) || undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    const rest = scheme[2]!;
    const authEnd = rest.indexOf('@');
    const afterAuth = authEnd === -1 ? rest : rest.slice(authEnd + 1);
    const slash = afterAuth.indexOf('/');
    if (slash === -1) return undefined;
    // The port is part of the address, not of the repo's identity: the same
    // repo reached over https (443) and ssh (22) must land on one key.
    const host = afterAuth.slice(0, slash).replace(/:\d+$/, '');
    const path = afterAuth.slice(slash + 1);
    // `file:///a/b` has no host: it is a local path key, like a bare `/a/b`.
    if (!path) return undefined;
    return strip(host ? `${host}/${path}` : `/${path}`) || undefined;
  }
  // scp-like: `[user@]host:path`.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(url);
  if (scp) return strip(`${scp[1]!}/${scp[2]!}`) || undefined;
  return strip(url) || undefined;
}
