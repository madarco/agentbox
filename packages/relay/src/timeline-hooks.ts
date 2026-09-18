// Timeline writers for work that happens outside the hub's own routes: RPCs a
// box sends the relay (`git.push`, the `gh` shim) and create jobs a queue worker
// finishes. Each runs after the real work has answered, so every one swallows
// its own failures — a log miss must never change an RPC result or a job status.
import { hostname } from 'node:os';
import { readState } from '@agentbox/sandbox-core';
import { ghRunContext, ghVerbArgv, resolveGhTarget, runHostGh } from './gh.js';
import type { QueueJob } from './queue.js';
import { managerIdForTarget } from './workspaces/manager.js';
import { pushLineStat, type PushStatInput } from './workspaces/push-stat.js';
import { readTasks } from './workspaces/task-store.js';
import { GH_PR_JSON_FIELDS, parsePrUrl, prTimelineEvents } from './workspaces/timeline-pr.js';
import type { GhPrJson } from './workspaces/timeline-pr.js';
import type { BoxWorkspaceKey } from './workspaces/workspace-store.js';
import { timelineSink } from './workspaces/timeline-sink.js';

export interface BoxTimelineContext {
  boxId: string;
  boxName?: string;
  /** Host path of the box's project: it picks the workspace. */
  hostPath: string;
  /** The branch the box pushes (its host-sanctioned branch). */
  branch?: string;
  originUrl?: string;
}

/**
 * How a box picks its workspace: its repo first, then the host folder. The relay
 * runs on the machine holding `hostPath`, so its own hostname is that folder's.
 */
function boxWorkspaceKey(ctx: BoxTimelineContext): BoxWorkspaceKey {
  return {
    ...(ctx.originUrl ? { originUrl: ctx.originUrl } : {}),
    host: hostname(),
    ...(ctx.hostPath ? { projectRoot: ctx.hostPath } : {}),
  };
}

async function boxTaskIds(wsId: string, boxId: string): Promise<string[]> {
  const tasks = await readTasks(wsId).catch(() => []);
  return tasks.filter((t) => t.boxId === boxId).map((t) => t.id);
}

/** How the relay classified a push, after checking its host-initiated token. */
export interface GitPushOrigin {
  /** A token the relay minted and just consumed, not merely a `hostInitiated` param. */
  hostInitiated: boolean;
  hostOnly: boolean;
}

/**
 * A push the box itself asked for. A host-initiated one came from the hub's git
 * route (or the CLI through it), which records it with the real caller; a
 * host-only landing publishes nothing and is recorded by that route too.
 */
export async function recordBoxGitPush(
  ctx: BoxTimelineContext,
  origin: GitPushOrigin,
  result: { exitCode: number },
  /** Where to read the push's +/- lines; the row has no diff without it. */
  stat?: PushStatInput,
): Promise<void> {
  if (result.exitCode !== 0 || origin.hostInitiated || origin.hostOnly) return;
  try {
    const ws = await timelineSink().workspaceFor(boxWorkspaceKey(ctx));
    if (!ws) return;
    const [taskIds, managerId, diff] = await Promise.all([
      boxTaskIds(ws.id, ctx.boxId),
      managerIdForTarget({ boxId: ctx.boxId }, { workspaceId: ws.id }),
      stat ? pushLineStat(stat) : undefined,
    ]);
    await timelineSink().record(ws.id, {
      type: 'git.push',
      actor: 'box',
      boxId: ctx.boxId,
      ...(ctx.boxName ? { boxName: ctx.boxName } : {}),
      ...(ctx.branch ? { branch: ctx.branch } : {}),
      ...(managerId ? { managerId } : {}),
      ...(taskIds.length ? { taskIds } : {}),
      ...(diff ?? {}),
    });
  } catch {
    /* best-effort */
  }
}

/** Flags of `gh pr merge` that consume the next argv element. */
const MERGE_VALUE_FLAGS = new Set([
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-t',
  '--subject',
  '-A',
  '--author-email',
  '--match-head-commit',
  '-R',
  '--repo',
]);

/** The PR a `gh pr merge` names (number, URL or branch), if it names one. */
export function prMergeTarget(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (MERGE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/** The repo a `gh pr merge` names with `-R`/`--repo`, if any. */
export function prMergeRepo(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '-R' || arg === '--repo') return rest[i + 1] || undefined;
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length) || undefined;
    if (arg.startsWith('-R') && arg.length > 2) return arg.slice(2);
    if (MERGE_VALUE_FLAGS.has(arg)) i++;
  }
  return undefined;
}

/** The `gh pr view` that reads a PR back, scoped to the repo the original command named. */
export function prViewArgs(
  lead: readonly string[],
  target: string,
  repo: string | undefined,
): string[] {
  return [
    ...lead,
    'pr',
    'view',
    target,
    ...(repo ? ['--repo', repo] : []),
    '--json',
    GH_PR_JSON_FIELDS,
  ];
}

/**
 * After an exit-0 `gh pr create` or `gh pr merge` from a box: read the PR back
 * and log what its state implies. The dedupe keys are the GitHub sync's, so the
 * sync finding the same PR later adds nothing. Readiness is left to the sync,
 * which reads a fresh check rollup.
 */
export async function recordBoxGhResult(
  ctx: BoxTimelineContext,
  args: readonly string[],
  result: { exitCode: number; stdout: string },
): Promise<void> {
  if (result.exitCode !== 0) return;
  const verb = ghVerbArgv(args);
  if (verb[0] !== 'pr' || (verb[1] !== 'create' && verb[1] !== 'merge')) return;
  try {
    const ws = await timelineSink().workspaceFor(boxWorkspaceKey(ctx));
    if (!ws) return;
    const target =
      verb[1] === 'create'
        ? parsePrUrl(result.stdout)?.url
        : (prMergeTarget(verb.slice(2)) ?? ctx.branch);
    if (!target) return;
    const lead = args.slice(0, args.length - verb.length);
    const ghTarget = await resolveGhTarget(ctx.originUrl);
    if (ghTarget.error) return;
    const repo = verb[1] === 'merge' ? prMergeRepo(verb.slice(2)) : undefined;
    const run = ghRunContext(ctx.hostPath, ctx.originUrl, prViewArgs(lead, target, repo));
    const view = await runHostGh(run.args, run.cwd, { host: ghTarget.host, timeoutMs: 20_000 });
    if (view.exitCode !== 0) return;
    const pr = JSON.parse(view.stdout) as GhPrJson;
    const parsed = parsePrUrl(pr.url);
    if (!parsed) return;
    const [taskIds, managerId] = await Promise.all([
      boxTaskIds(ws.id, ctx.boxId),
      managerIdForTarget({ boxId: ctx.boxId }, { workspaceId: ws.id }),
    ]);
    const events = prTimelineEvents(pr, parsed.repo, {
      actor: 'box',
      boxId: ctx.boxId,
      ...(ctx.boxName ? { boxName: ctx.boxName } : {}),
      ...(managerId ? { managerId } : {}),
      ...(taskIds.length ? { taskIds } : {}),
    });
    for (const ev of events) {
      if (ev.type === 'pr.ready') continue;
      await timelineSink().record(ws.id, ev);
    }
  } catch {
    /* best-effort */
  }
}

/** The registry id for the wire alias a queue job carries. */
function jobAgent(job: QueueJob): string | undefined {
  if (job.noAgent) return undefined;
  return job.agent === 'claude-code' ? 'claude' : job.agent;
}

/**
 * A create job reached a terminal status: `box.ready` or `box.failed` in the
 * workspace its folder belongs to. Called by the worker that finished it and by
 * the queue loop when a worker could not start or died; the job-scoped key keeps
 * a double report to one event.
 */
export async function recordCreateJobTimeline(job: QueueJob): Promise<void> {
  if (job.kind === 'prepare') return;
  if (job.status !== 'done' && job.status !== 'failed') return;
  try {
    const ws = await timelineSink().workspaceFor({
      host: hostname(),
      projectRoot: job.createOpts.workspace,
      // A hub-routed create clones into a throwaway folder, so its job's
      // `workspace` names nothing a workspace maps; the repo is the only key
      // that joins it.
      ...(job.createOpts.repoUrl ? { originUrl: job.createOpts.repoUrl } : {}),
    });
    if (!ws) return;
    const box = job.boxId
      ? (await readState().catch(() => null))?.boxes.find((b) => b.id === job.boxId)
      : undefined;
    const [tasks, byJob, byBox] = await Promise.all([
      readTasks(ws.id).catch(() => []),
      managerIdForTarget({ boxJobId: job.id }, { workspaceId: ws.id }),
      job.boxId
        ? managerIdForTarget({ boxId: job.boxId }, { workspaceId: ws.id })
        : Promise.resolve(undefined),
    ]);
    const taskIds = tasks
      .filter((t) => t.boxJobId === job.id || (job.boxId !== undefined && t.boxId === job.boxId))
      .map((t) => t.id);
    const managerId = byJob ?? byBox;
    const name = box?.name ?? (job.boxName || job.createOpts.name);
    const branch = box?.gitWorktrees?.[0]?.branch ?? box?.cloud?.workspaceBranch;
    const agent = jobAgent(job);
    const ready = job.status === 'done';
    await timelineSink().record(ws.id, {
      type: ready ? 'box.ready' : 'box.failed',
      actor: 'hub',
      key: `job:${job.id}:${ready ? 'ready' : 'failed'}`,
      ...(job.boxId ? { boxId: job.boxId } : {}),
      ...(name ? { boxName: name } : {}),
      ...(agent ? { agent } : {}),
      ...(branch ? { branch } : {}),
      ...(job.createOpts.fromBranch ? { base: job.createOpts.fromBranch } : {}),
      ...(managerId ? { managerId } : {}),
      ...(taskIds.length ? { taskIds } : {}),
      ...(!ready && job.reason ? { text: job.reason.slice(0, 500) } : {}),
    });
  } catch {
    /* best-effort */
  }
}
