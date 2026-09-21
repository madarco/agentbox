import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from './exec.js';

export let TEST_REPO = 'madarco/agentbox-test-repo';
export function setTestRepo(repo: string): void {
  TEST_REPO = repo;
}

async function gh(args: string[], log?: string): Promise<string> {
  return (await run('gh', args, { log })).stdout.trim();
}

async function ghJson<T>(args: string[], log?: string): Promise<T> {
  return JSON.parse(await gh(args, log)) as T;
}

/** Fresh https clone; https because the e2e home pushes through `gh auth git-credential`. */
export async function cloneTestRepo(dest: string, log: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  await run('git', ['clone', '-q', `https://github.com/${TEST_REPO}.git`, dest], {
    log,
    timeoutMs: 180_000,
  });
}

/** The local state a user has mid-task: one staged change, one untracked file. */
export function makeDirty(repo: string, tag: string): { staged: string; untracked: string } {
  const staged = `e2e-staged-${tag}.txt`;
  const untracked = `e2e-untracked-${tag}.txt`;
  writeFileSync(join(repo, staged), `staged ${tag}\n`);
  writeFileSync(join(repo, untracked), `untracked ${tag}\n`);
  return { staged, untracked };
}

export async function gitIn(repo: string, args: string[], log: string): Promise<string> {
  return (await run('git', args, { cwd: repo, log })).stdout.trim();
}

/**
 * A per-scenario base branch cut from main. PRs merge into it, never into `main`,
 * so a run leaves the test repo exactly as it found it.
 */
export async function createBaseBranch(name: string, log: string): Promise<void> {
  const sha = await gh(['api', `repos/${TEST_REPO}/git/ref/heads/main`, '-q', '.object.sha'], log);
  await gh(
    [
      'api',
      '-X',
      'POST',
      `repos/${TEST_REPO}/git/refs`,
      '-f',
      `ref=refs/heads/${name}`,
      '-f',
      `sha=${sha}`,
    ],
    log,
  );
}

export async function branchHeadMessage(branch: string, log: string): Promise<string | undefined> {
  const r = await run(
    'gh',
    [
      'api',
      `repos/${TEST_REPO}/branches/${encodeURIComponent(branch)}`,
      '-q',
      '.commit.commit.message',
    ],
    { log, allowFail: true },
  );
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

export interface PrInfo {
  number: number;
  state: string;
  url: string;
  mergedAt: string | null;
  baseRefName: string;
}

export async function prForHead(head: string, log: string): Promise<PrInfo | undefined> {
  const prs = await ghJson<PrInfo[]>(
    [
      'pr',
      'list',
      '-R',
      TEST_REPO,
      '--head',
      head,
      '--state',
      'all',
      '--json',
      'number,state,url,mergedAt,baseRefName',
    ],
    log,
  );
  return prs[0];
}

export async function fileOnBranch(
  branch: string,
  path: string,
  log: string,
): Promise<string | undefined> {
  const r = await run(
    'gh',
    [
      'api',
      `repos/${TEST_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      '-H',
      'Accept: application/vnd.github.raw',
    ],
    { log, allowFail: true },
  );
  return r.exitCode === 0 ? r.stdout : undefined;
}

/** Close open PRs and delete every branch a run created (`e2e/<run>/…`, `agentbox/e2e-<run>-…`). */
export async function cleanupGithub(runId: string, log: string): Promise<string[]> {
  const removed: string[] = [];
  const refs = await ghJson<Array<{ ref: string }>>(
    ['api', '--paginate', `repos/${TEST_REPO}/git/matching-refs/heads/`],
    log,
  );
  const ours = refs
    .map((r) => r.ref.replace(/^refs\/heads\//, ''))
    .filter((b) => b.startsWith(`e2e/${runId}/`) || b.startsWith(`agentbox/e2e-${runId}-`));
  const open = await ghJson<Array<{ number: number; headRefName: string }>>(
    [
      'pr',
      'list',
      '-R',
      TEST_REPO,
      '--state',
      'open',
      '--json',
      'number,headRefName',
      '--limit',
      '200',
    ],
    log,
  );
  for (const pr of open) {
    if (ours.includes(pr.headRefName)) {
      await run('gh', ['pr', 'close', String(pr.number), '-R', TEST_REPO], {
        log,
        allowFail: true,
      });
    }
  }
  for (const b of ours) {
    const r = await run('gh', ['api', '-X', 'DELETE', `repos/${TEST_REPO}/git/refs/heads/${b}`], {
      log,
      allowFail: true,
    });
    if (r.exitCode === 0) removed.push(b);
  }
  return removed;
}
