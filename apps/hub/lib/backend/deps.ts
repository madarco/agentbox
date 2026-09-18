import type { ManagerExec } from '@agentbox/relay';
// The seams a domain backend slice is built from.
//
// `lib/hub-backend.ts` had grown past 3800 lines because every feature appended
// its methods there. A slice takes this narrow dependency object instead of the
// relay handle, so it can be unit-tested without a relay and reviewed without
// reading the box/provider code it does not touch.
import type { QueueJob, ReconcileContext } from '@agentbox/relay';

/** What the timeline needs to know about one box, read from the host's records. */
export interface TimelineBoxFact {
  id: string;
  name: string;
  /** The box's create-time branch and its host-sanctioned one, deduplicated. */
  branches: string[];
  /** Persisted runtime state (`running`, `paused`, ...); absent when unknown. */
  state?: string;
  agent?: string;
  projectRoot: string;
  projectId: string;
  /**
   * The box repo's `origin`, when this hub can name it. The only workspace key
   * that survives a box with no checkout here (a cloud box, or one another
   * machine created), so the timeline joins on it before the folder.
   */
  originUrl?: string;
  /** The machine `projectRoot` is on — this hub's own hostname for a local record. */
  host?: string;
}

export interface DiffStat {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export type GhExec = (
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface BackendDeps {
  /**
   * How the manager's tmux commands are run. Present only so a test can drive
   * the start path without spawning anything: a guard regression in
   * `startManager` would otherwise launch a real coding agent on whoever's
   * machine is running the suite. Production leaves it unset and the relay uses
   * execa.
   */
  managerExec?: ManagerExec;
  /**
   * Fire the hub's live-update fan-out (`/api/events` emits `change`). Called
   * after every mutation so an open UI refetches instead of waiting for its
   * 15s heartbeat.
   */
  notify(): void;
  /**
   * Ids of boxes that exist right now: this machine's local records UNION the
   * Store's registrations. Read to VALIDATE an assignment (`--tasks` on a box
   * that is not there), never to invalidate one — a box on another machine
   * reporting to the same store is absent from this listing and still alive.
   */
  liveBoxIds(): Promise<Set<string>>;
  /** The local create queue, for resolving a task's pending create job. */
  jobs(): Promise<QueueJob[]>;
  /**
   * The hub's own hostname and pid probe. A manager's pid is only probed when it
   * was reported from this host; tests pin both so the status matrix does not
   * depend on the machine running the suite.
   */
  hostname?: () => string;
  isPidAlive?: (pid: number) => boolean;
  /** `ps -o lstart=` of a pid; faked in tests like the pid probe. */
  processStartTime?: (pid: number) => Promise<string | undefined>;
  /** Every box this hub has a record for. Absent: the timeline names no boxes. */
  boxFacts?(): Promise<TimelineBoxFact[]>;
  /**
   * One box's persisted record, without listing the fleet. `withState` also
   * reads its runtime state (a docker inspect, or a cloud box's last state).
   */
  boxFact?(id: string, opts?: { withState?: boolean }): Promise<TimelineBoxFact | undefined>;
  /** The branch a project's host checkout is on (a create's default base); undefined on any failure. */
  projectBranch?(projectId: string): Promise<string | undefined>;
  /** `git diff --shortstat` in a running box; null when the exec fails. */
  boxDiffStat?(box: TimelineBoxFact): Promise<DiffStat | null>;
  /** Box ids with a pending host-action approval. */
  pendingApprovalBoxIds?(): string[];
  /** How the GitHub sync runs `gh`; tests fake it, production spawns the host's gh. */
  ghExec?: GhExec;
}

/**
 * The job facts reconciliation needs — every queue manifest, so a call that
 * reconciles several workspaces reads them ONCE and hands the same snapshot
 * down. No box inventory: a pointer is dropped by an explicit destroy or prune
 * (`boxGone`), never by absence from this hub's listing.
 */
export async function reconcileContext(deps: BackendDeps): Promise<ReconcileContext> {
  const jobs = await deps.jobs();
  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      ...(j.boxId ? { boxId: j.boxId } : {}),
    })),
  };
}
