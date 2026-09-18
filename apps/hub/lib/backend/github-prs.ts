// GitHub pull requests into the workspace timeline. The in-box `gh` shim records
// the PRs a box opens or merges; this sync covers everything else — the manager
// merging from the host, a merge on github.com, auto-merge landing later — by
// polling `gh pr list` for the repos the workspace's projects name. The dedupe
// keys are shared with the shim (`prTimelineEvents`), so both paths land once.
//
// Every `gh` call here is repo-addressed and runs with NO cwd: the repo comes
// from the workspace record's `repoUrl`, not from a checkout. A control box has
// no folder for any of it — its record of a project is a repo and nothing else —
// and reading one from disk is what used to make the sync answer `unavailable`
// there. One code path serves both hubs.
import { hostname as osHostname } from 'node:os';
import { hashProjectPath } from '@agentbox/config';
import { execa } from 'execa';
import {
  appendTimelineEvent,
  GH_PR_JSON_FIELDS,
  ghRepoArg,
  isPrReady,
  listWorkspaces,
  normalizeRepoUrl,
  prTimelineEvents,
  readTasks,
  readTimeline,
  TIMELINE_RETENTION_MS,
  workspaceForBox,
  type GhPrJson,
  type TimelineEvent,
  type WorkspaceProject,
  type WorkspaceRecord,
} from '@agentbox/relay';
import type { BackendDeps, GhExec } from './deps';

/** `unavailable`: no `gh`, not logged in, or no GitHub repo behind the workspace. */
export type GithubSyncStatus = 'ok' | 'syncing' | 'unavailable';

export type PrLiveState = 'ready' | 'open' | 'merged' | 'closed';

export interface GithubPrSync {
  /** Start a sync when the last one is older than the interval; answers the current status. */
  kick(ws: WorkspaceRecord): GithubSyncStatus;
  /** The current status without starting a sync: `syncing` until one has finished. */
  status(wsId: string): GithubSyncStatus;
  /** Run one sync now and wait for it (tests, and a caller that needs it done). */
  syncNow(ws: WorkspaceRecord): Promise<GithubSyncStatus>;
  /** The state a PR had at the last sync, when this hub has seen it. */
  prState(repo: string, number: number): PrLiveState | undefined;
  /** Bumped whenever a sync changes a PR's state, so a reader can drop what it derived from them. */
  statesVersion(): number;
  /**
   * Whether a sync of this workspace has completed since the hub started. PR
   * states live in memory, so before that no logged `pr.ready` is confirmed.
   */
  synced(wsId: string): boolean;
  /**
   * The web URL of the GitHub repo behind a repo URL, from the cache a sync
   * fills. Never runs `gh`: undefined until a sync has looked that repo up.
   */
  webUrlForRepoUrl(repoUrl: string): string | undefined;
  /**
   * The same by project id — the workspace's own id for a repo, and, where this
   * hub has a folder for it, that folder's hash too (what a box fact carries).
   */
  webUrlForProject(projectId: string): string | undefined;
  /** The web URL of a repo (`owner/name`) a sync resolved, on the host it lives on. */
  webUrlForRepo(nameWithOwner: string): string | undefined;
}

export const GITHUB_SYNC_INTERVAL_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;
const PR_LIST_LIMIT = 50;

const defaultGhExec: GhExec = async (args, opts) => {
  const r = await execa('gh', args, {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    reject: false,
    timeout: GH_TIMEOUT_MS,
  });
  return {
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
};

interface WorkspaceSyncState {
  lastAt: number;
  running: Promise<GithubSyncStatus> | null;
  status: GithubSyncStatus | null;
  confirmed: boolean;
}

interface RepoRef {
  /** `owner/name`: the dedupe key's repo. */
  nameWithOwner: string;
  /** What `--repo` takes: `HOST/owner/name` off github.com. */
  arg: string;
  /** `https://<host>/owner/name`. */
  webUrl: string;
}

export function createGithubPrSync(
  deps: BackendDeps,
  opts: { now?: () => number; intervalMs?: number; hostname?: () => string } = {},
): GithubPrSync {
  const gh = deps.ghExec ?? defaultGhExec;
  const host = opts.hostname ?? deps.hostname ?? osHostname;
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? GITHUB_SYNC_INTERVAL_MS;
  const states = new Map<string, WorkspaceSyncState>();
  /** Keyed by normalised repo URL; `null` = not a GitHub repo, cached so it is not asked again. */
  const repoByUrl = new Map<string, RepoRef | null>();
  const refByProjectId = new Map<string, RepoRef>();
  let ghUser: { login: string | null; at: number } | null = null;
  const prStates = new Map<string, PrLiveState>();
  let statesVersion = 0;

  async function currentUser(): Promise<string | null> {
    if (ghUser && (ghUser.login !== null || now() - ghUser.at < interval)) return ghUser.login;
    const r = await gh(['api', 'user', '--jq', '.login']).catch(() => null);
    const login = r && r.exitCode === 0 ? r.stdout.trim() || null : null;
    ghUser = { login, at: now() };
    return login;
  }

  async function repoOf(project: WorkspaceProject): Promise<RepoRef | null> {
    const key = normalizeRepoUrl(project.repoUrl);
    // No remote: the project exists only where its folder is, and there is
    // nothing on GitHub to poll for it.
    if (!key) return null;
    if (repoByUrl.has(key)) return repoByUrl.get(key) ?? null;
    const arg = ghRepoArg(project.repoUrl);
    if (!arg) {
      repoByUrl.set(key, null);
      return null;
    }
    const r = await gh(['repo', 'view', arg, '--json', 'nameWithOwner,url']).catch(() => null);
    let ref: RepoRef | null = null;
    if (r && r.exitCode === 0) {
      try {
        const parsed = JSON.parse(r.stdout) as { nameWithOwner?: string; url?: string };
        if (parsed.nameWithOwner) {
          const host = parsed.url ? new URL(parsed.url).host : 'github.com';
          ref = {
            nameWithOwner: parsed.nameWithOwner,
            arg: host === 'github.com' ? parsed.nameWithOwner : `${host}/${parsed.nameWithOwner}`,
            webUrl: `https://${host}/${parsed.nameWithOwner}`,
          };
        }
      } catch {
        ref = null;
      }
    }
    // A failed lookup is cached only when gh answered: a timeout says nothing
    // about whether the repo is on GitHub.
    if (r) repoByUrl.set(key, ref);
    return ref;
  }

  async function sync(ws: WorkspaceRecord): Promise<GithubSyncStatus> {
    const user = await currentUser();
    if (user === null) return 'unavailable';
    // The repos the workspace names, wherever they are checked out — including
    // nowhere. A project with no remote contributes none.
    const folders = ws.hosts[host()]?.projectRoots ?? {};
    const repos = new Map<string, RepoRef>();
    for (const project of ws.projects) {
      const ref = await repoOf(project);
      if (!ref) continue;
      repos.set(ref.nameWithOwner, ref);
      refByProjectId.set(project.id, ref);
      // A box's fact keys its project by the folder's hash, so a hub that HAS
      // the folder indexes the repo under that id too, for the branch links.
      const root = folders[project.id];
      if (root) refByProjectId.set(hashProjectPath(root), ref);
    }
    if (repos.size === 0) return 'unavailable';

    const [events, facts, tasks, workspaces] = await Promise.all([
      readTimeline(ws.id),
      deps.boxFacts ? deps.boxFacts().catch(() => []) : Promise.resolve([]),
      readTasks(ws.id).catch(() => []),
      listWorkspaces(),
    ]);
    const boxes = facts.filter((b) => workspaceForBox(workspaces, b, host())?.id === ws.id);
    const known = new Set<string>();
    for (const b of boxes) for (const br of b.branches) known.add(br);
    for (const ev of events) if (ev.branch) known.add(ev.branch);
    const since = ws.createdAt.slice(0, 10);
    const floor = now() - TIMELINE_RETENTION_MS;
    let appended = 0;

    for (const ref of repos.values()) {
      const r = await gh([
        'pr',
        'list',
        '--repo',
        ref.arg,
        '--state',
        'all',
        '--limit',
        String(PR_LIST_LIMIT),
        '--search',
        `updated:>=${since}`,
        '--json',
        GH_PR_JSON_FIELDS,
      ]).catch(() => null);
      if (!r || r.exitCode !== 0) continue;
      let prs: GhPrJson[];
      try {
        prs = JSON.parse(r.stdout) as GhPrJson[];
      } catch {
        continue;
      }
      for (const pr of prs) {
        const prKey = `${ref.nameWithOwner}#${String(pr.number)}`;
        const live: PrLiveState =
          pr.state === 'MERGED'
            ? 'merged'
            : pr.state === 'CLOSED'
              ? 'closed'
              : isPrReady(pr)
                ? 'ready'
                : 'open';
        if (prStates.get(prKey) !== live) {
          prStates.set(prKey, live);
          statesVersion += 1;
        }
        // A PR is the workspace's when its branch is one the workspace worked
        // on, or when the gh user opened it — which is how the manager's own
        // host-side PRs get in.
        if (!known.has(pr.headRefName) && pr.author?.login !== user) continue;
        const box = boxes.find((b) => b.branches.includes(pr.headRefName));
        const seen = events.find((ev) => ev.branch === pr.headRefName && ev.boxId);
        const boxTaskIds = box
          ? tasks.filter((t) => t.boxId === box.id).map((t) => t.id)
          : undefined;
        const taskIds = boxTaskIds?.length ? boxTaskIds : seen?.taskIds;
        const base: Omit<TimelineEvent, 'id' | 'at' | 'type' | 'pr' | 'key'> = {
          actor: 'github',
          ...(box ? { boxId: box.id, boxName: box.name } : {}),
          ...(!box && seen?.boxId ? { boxId: seen.boxId } : {}),
          ...(!box && seen?.boxName ? { boxName: seen.boxName } : {}),
          ...(seen?.managerId ? { managerId: seen.managerId } : {}),
          ...(taskIds?.length ? { taskIds } : {}),
        };
        for (const ev of prTimelineEvents(
          pr,
          ref.nameWithOwner,
          base,
          new Date(now()).toISOString(),
        )) {
          // An event older than the log keeps is dropped by the next compaction
          // anyway; appending it would only re-add what was compacted away.
          if (ev.at && Date.parse(ev.at) < floor) continue;
          if (await appendTimelineEvent(ws.id, ev).catch(() => null)) appended += 1;
        }
      }
    }
    if (appended > 0) deps.notify();
    return 'ok';
  }

  function stateOf(wsId: string): WorkspaceSyncState {
    let st = states.get(wsId);
    if (!st) {
      st = { lastAt: 0, running: null, status: null, confirmed: false };
      states.set(wsId, st);
    }
    return st;
  }

  function run(ws: WorkspaceRecord): Promise<GithubSyncStatus> {
    const st = stateOf(ws.id);
    if (st.running) return st.running;
    st.running = sync(ws)
      .catch((): GithubSyncStatus => 'unavailable')
      .then((status) => {
        st.status = status;
        if (status === 'ok') st.confirmed = true;
        st.lastAt = now();
        st.running = null;
        return status;
      });
    return st.running;
  }

  return {
    kick(ws) {
      const st = stateOf(ws.id);
      if (!st.running && now() - st.lastAt >= interval) void run(ws);
      return st.status ?? 'syncing';
    },
    status(wsId) {
      return states.get(wsId)?.status ?? 'syncing';
    },
    syncNow: run,
    prState(repo, number) {
      return prStates.get(`${repo}#${String(number)}`);
    },
    statesVersion: () => statesVersion,
    synced(wsId) {
      return states.get(wsId)?.confirmed ?? false;
    },
    webUrlForRepoUrl(repoUrl) {
      const key = normalizeRepoUrl(repoUrl);
      return key === undefined ? undefined : (repoByUrl.get(key)?.webUrl ?? undefined);
    },
    webUrlForProject(projectId) {
      return refByProjectId.get(projectId)?.webUrl;
    },
    webUrlForRepo(nameWithOwner) {
      for (const ref of repoByUrl.values()) {
        if (ref?.nameWithOwner === nameWithOwner) return ref.webUrl;
      }
      return undefined;
    },
  };
}
