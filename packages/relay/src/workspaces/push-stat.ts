// The +/- lines a push carried, read from the HOST repo the push went through —
// or, when this hub has no checkout of it, from inside the box. A control box's
// record of a box points at the create job's deleted temp clone, so the host
// half answers nothing there and the row would arrive with no diff.
import { execa } from 'execa';

export interface PushLineStat {
  additions: number;
  deletions: number;
}

export interface PushStatInput {
  /** The host repo the push moved a ref in. */
  repo: string;
  /** The ref the push moved (see {@link pushedRef}). */
  ref: string;
  /** Tried as `refs/heads/<branch>` when `ref` does not resolve (a push by URL has no tracking ref). */
  branch: string;
  /** `ref`'s tip before the push; absent for a first push. */
  before?: string;
  timeoutMs?: number;
}

/** One budget for every git call a stat makes: a push row is not worth a slow hub. */
export const PUSH_STAT_TIMEOUT_MS = 2000;

/**
 * The same budget for the BOX half, which needs its own number: the host half
 * runs `git` on this disk (milliseconds a call), while every call here is a
 * round trip to a sandbox that may be on another continent from the hub — three
 * to seven of them, measured at ~0.5 s each against a live E2B box. It costs
 * nobody's latency: the row is recorded in the background, after the push has
 * already answered.
 */
export const BOX_PUSH_STAT_TIMEOUT_MS = 10_000;

/** Candidates for the default branch a first push is measured against, in order. */
const DEFAULT_BRANCH_REFS = [
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
];

/** `N files changed, A insertions(+), D deletions(-)`, any part optional. */
export function parseShortstat(out: string): {
  filesChanged: number;
  additions: number;
  deletions: number;
} {
  const num = (re: RegExp): number => Number(re.exec(out)?.[1] ?? 0);
  return {
    filesChanged: num(/(\d+) files? changed/u),
    additions: num(/(\d+) insertions?\(\+\)/u),
    deletions: num(/(\d+) deletions?\(-\)/u),
  };
}

/**
 * The host ref a push moves: the remote-tracking ref for a push to a named
 * remote, the local branch for a host-only landing or a push by URL.
 */
export function pushedRef(branch: string, opts: { remote?: string; hostOnly?: boolean }): string {
  const remote = opts.remote ?? 'origin';
  if (opts.hostOnly || !/^[A-Za-z0-9._-]+$/u.test(remote)) return `refs/heads/${branch}`;
  return `refs/remotes/${remote}/${branch}`;
}

type Git = (args: string[]) => Promise<string | undefined>;

function gitWithin(repo: string, deadline: number): Git {
  return async (args) => {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    try {
      const r = await execa('git', ['-C', repo, ...args], { reject: false, timeout: left });
      return r.exitCode === 0 ? r.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  };
}

function tipWith(git: Git, ref: string): Promise<string | undefined> {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((s) => s || undefined);
}

/** A ref's commit, or undefined when it does not exist (or git is slow or absent). */
export function readRefTip(
  repo: string,
  ref: string,
  timeoutMs = PUSH_STAT_TIMEOUT_MS,
): Promise<string | undefined> {
  return tipWith(gitWithin(repo, Date.now() + timeoutMs), ref);
}

/** The branch a checkout is on; undefined on a detached HEAD, a slow git, or no repo. */
export function readCurrentBranch(repo: string, timeoutMs = 1000): Promise<string | undefined> {
  const git = gitWithin(repo, Date.now() + timeoutMs);
  return git(['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s || undefined);
}

async function defaultBranchBase(git: Git, tip: string): Promise<string | undefined> {
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  for (const ref of [...(head ? [head] : []), ...DEFAULT_BRANCH_REFS]) {
    if (!(await tipWith(git, ref))) continue;
    return git(['merge-base', ref, tip]);
  }
  return undefined;
}

/** True only when git positively says `before` is an ancestor of `after` (exit 0). */
async function isAncestor(git: Git, before: string, after: string): Promise<boolean> {
  return (await git(['merge-base', '--is-ancestor', before, after])) !== undefined;
}

/**
 * Lines added and removed by a push: `before..after` when the old tip is known
 * and still an ancestor, else from the merge base with the default branch (a
 * first push, or a rebase + force-push whose `before..after` would count the
 * upstream changes it was rebased onto). Undefined on anything unexpected,
 * including a push that moved nothing: the row just has no diff.
 */
export async function pushLineStat(input: PushStatInput): Promise<PushLineStat | undefined> {
  const git = gitWithin(input.repo, Date.now() + (input.timeoutMs ?? PUSH_STAT_TIMEOUT_MS));
  const after =
    (await tipWith(git, input.ref)) ?? (await tipWith(git, `refs/heads/${input.branch}`));
  if (!after) return undefined;
  const base =
    input.before && (input.before === after || (await isAncestor(git, input.before, after)))
      ? input.before
      : await defaultBranchBase(git, after);
  if (!base || base === after) return undefined;
  const out = await git(['diff', '--shortstat', `${base}..${after}`]);
  if (out === undefined) return undefined;
  const { additions, deletions } = parseShortstat(out);
  return additions + deletions > 0 ? { additions, deletions } : undefined;
}

// ── the box half ──

/** One `git` run inside a box's workspace, however this process reaches boxes. */
export type BoxGitExec = (args: string[]) => Promise<{ exitCode: number; stdout: string }>;

/**
 * Candidates for the base a box-side stat is measured from, in order. `origin/HEAD`
 * first (the clone recorded the remote's default branch), then the usual names —
 * the box is a clone, so both the remote-tracking refs and the local branches may
 * be there.
 */
const BOX_BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];

/**
 * The same measurement as {@link pushLineStat}, run inside the box instead of on
 * a host repo: `before..HEAD` when the old tip is known and still an ancestor,
 * else from the merge base with the default branch. Bounded by one budget across
 * every exec, and undefined on anything unexpected — a row with no diff is the
 * worst this may cost.
 */
export async function boxPushLineStat(
  exec: BoxGitExec,
  opts: { before?: string; timeoutMs?: number } = {},
): Promise<PushLineStat | undefined> {
  const deadline = Date.now() + (opts.timeoutMs ?? BOX_PUSH_STAT_TIMEOUT_MS);
  const run = async (args: string[]): Promise<{ exitCode: number; stdout: string } | undefined> => {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    try {
      return await Promise.race([
        exec(args),
        new Promise<undefined>((resolve) => {
          const t = setTimeout(() => resolve(undefined), left);
          t.unref?.();
        }),
      ]);
    } catch {
      return undefined;
    }
  };
  const out = async (args: string[]): Promise<string | undefined> => {
    const r = await run(args);
    return r && r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
  };
  const head = await out(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head) return undefined;
  // A push that moved nothing has no diff to report, exactly as on the host.
  if (opts.before === head) return undefined;
  let base: string | undefined;
  if (opts.before) {
    const ancestor = await run(['merge-base', '--is-ancestor', opts.before, head]);
    if (ancestor?.exitCode === 0) base = opts.before;
  }
  if (!base) {
    for (const ref of BOX_BASE_REFS) {
      base = await out(['merge-base', ref, head]);
      if (base) break;
    }
  }
  if (!base || base === head) return undefined;
  const shortstat = await out(['diff', '--shortstat', `${base}..${head}`]);
  if (shortstat === undefined) return undefined;
  const { additions, deletions } = parseShortstat(shortstat);
  return additions + deletions > 0 ? { additions, deletions } : undefined;
}

/**
 * How this process measures a push inside a box. The relay has no provider
 * modules — it never creates or drives a box — so the hub, which does, installs
 * the runner at start. Left unset (a standalone relay) a push it cannot read on
 * disk simply gets no diff.
 */
export type BoxPushStat = (
  boxId: string,
  opts?: { before?: string },
) => Promise<PushLineStat | undefined>;

let currentBoxPushStat: BoxPushStat | null = null;

/** Install the runner (`null` clears it). */
export function configureBoxPushStat(fn: BoxPushStat | null): void {
  currentBoxPushStat = fn;
}

/** The installed runner, or null when this process cannot reach into a box. */
export function boxPushStat(): BoxPushStat | null {
  return currentBoxPushStat;
}
