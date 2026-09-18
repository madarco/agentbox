import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/sandbox-core';
import type { AgentId } from '@agentbox/core';

/** Root of the workspace registry: one directory per workspace, keyed by its id. */
export const WORKSPACES_DIR = join(STATE_DIR, 'workspaces');

/**
 * One project inside a workspace. Identified by its REPO, not by a folder: the
 * same repo is checked out at a different path on every machine, and a control
 * box holds no checkout at all, so a folder-keyed id cannot join a box to its
 * workspace from anywhere but the machine that cloned it.
 */
export interface WorkspaceProject {
  /**
   * `hashProjectPath(normalizeRepoUrl(repoUrl))` when the project has a remote,
   * else `hashProjectPath('<host>:<folder>')` — a project with no remote exists
   * only on the machine holding it, so its id says so.
   */
  id: string;
  name: string;
  /** The `origin` remote, as the scanning host spelled it. */
  repoUrl?: string;
}

/** Where one machine keeps a workspace's folders. */
export interface WorkspaceHost {
  /** Absolute, realpath'd folder on that machine. */
  root: string;
  /** `WorkspaceProject.id` → the project's absolute path on that machine. */
  projectRoots: Record<string, string>;
  seenAt: string;
}

/**
 * A workspace groups one or more projects and owns a task list plus
 * (optionally) manager agent sessions. It is deliberately not a project: a
 * project is one repo/agentbox.yaml root a box is built from, while a workspace
 * is the unit a human (and its managers) plan across.
 *
 * The record is machine-independent: `projects` are repos, and `hosts` maps each
 * machine that has a checkout to its folders. A hub that owns boxes for a repo
 * it never cloned (a control box) still joins those boxes to this workspace.
 *
 * `id` is random (16 hex, the manager-id generator), not a path hash: the same
 * workspace has a different root on every machine.
 */
export interface WorkspaceRecord {
  version: 2;
  id: string;
  name: string;
  projects: WorkspaceProject[];
  /** Keyed by `os.hostname()` of the machine. */
  hosts: Record<string, WorkspaceHost>;
  /**
   * Monotonic counter behind `T-<n>` task ids. Never decremented, so a deleted
   * task's id is not handed to a later one — stale references in a manager
   * transcript or a PR body must not silently resolve to different work.
   */
  taskCounter: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * API view of a workspace: the record minus its internal counter and on-disk
 * version, plus what a client joins on — the project ids visible from the
 * reading hub, and that hub's own folder when it has one.
 */
export type Workspace = Omit<WorkspaceRecord, 'taskCounter' | 'version'> & {
  /**
   * The ids a client may hold for these projects: each `WorkspaceProject.id`,
   * plus `hashProjectPath(folder)` of every folder the reading hub has locally
   * — that is the id the project registry and a box record use.
   */
  projectIds: string[];
  /** `hosts[<the reading hub's hostname>].root`; absent when it has no checkout. */
  root?: string;
};

export type WorkTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';

export const WORK_TASK_STATUSES: readonly WorkTaskStatus[] = [
  'todo',
  'in_progress',
  'blocked',
  'done',
];

export type WorkTaskCreatedBy = 'human' | 'manager' | 'api';

/**
 * Where this task came from in an external tracker. One ticket routinely becomes
 * several local tasks, so this is a back-reference, never an identity.
 */
export interface WorkTaskExternalRef {
  kind: 'linear' | (string & {});
  id: string;
  url?: string;
}

/**
 * A unit of work. Owned by a workspace; optionally scoped to one project and
 * assigned to one box. Many tasks map to a single box on purpose — the manager
 * groups tasks that touch the same files so they share a branch instead of
 * racing for it.
 */
export interface WorkTask {
  /** `T-<n>`, unique within the workspace. */
  id: string;
  workspaceId: string;
  projectId?: string;
  title: string;
  description?: string;
  status: WorkTaskStatus;
  /** Position in the list. The list order IS the priority. */
  order: number;
  boxId?: string;
  /**
   * A create job that has not produced a box id yet. Mutually exclusive with
   * `boxId`: reconciliation promotes one to the other once the worker records
   * the box, so a task assigned at create time is never orphaned by the gap.
   */
  boxJobId?: string;
  /** The manager session this task belongs to. Inherited from its box on assignment. */
  managerId?: string;
  dependsOn?: string[];
  createdBy: WorkTaskCreatedBy;
  externalRef?: WorkTaskExternalRef;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}

/** On-disk shape of `tasks.json`. */
export interface TaskFile {
  version: 1;
  tasks: WorkTask[];
}

/**
 * The agent a manager runs. Open (`AgentId`), not an enumeration: which agents
 * exist is a runtime fact — `agentbox agent add` registers more — and the API's
 * accept-list is the hub's request validator, not this type.
 */
export type ManagerAgent = AgentId;

/**
 * `external` is a session the user runs in their own terminal — the hub only
 * observes it, through detection. `tmux` is one a hub started (or resumed) in a
 * tmux session on its own machine, so it can also be attached to and stopped.
 *
 * Named after the session, not after "the hub", because the hub that RUNS it and
 * the hub that STORES it need not be the same machine: a manager runs on the
 * user's PC while its record lives on the control box.
 */
export type ManagerKind = 'external' | 'tmux';

/**
 * A manager is a HOST agent session that orchestrates boxes: many per workspace.
 * It is registered when the `agentbox` CLI runs inside it (detection), or when
 * the hub starts one.
 */
export interface ManagerRecord {
  /** 16 hex, random: a hub-run manager has no session id until it is detected. */
  id: string;
  workspaceId: string;
  agent: ManagerAgent;
  kind: ManagerKind;
  /** Realpath of the folder the session runs in — where a resume must run. */
  cwd: string;
  /** Claude session uuid / codex thread uuid. */
  sessionId?: string;
  /** Cached first-turn title, scraped lazily from the agent's own store. */
  title?: string;
  /**
   * `os.hostname()` of the machine the session runs on. Required: a manager is a
   * process in a folder, and every probe (pid, tmux, transcript) is only
   * meaningful there. A hub whose hostname differs holds the record, not the
   * session.
   */
  host: string;
  /** External only. */
  pid?: number;
  /**
   * External only: the pid's start time, recorded when the detect came from the
   * hub's own machine. A live pid with a different start time is a reused pid.
   */
  pidStartedAt?: string;
  /**
   * External only: `$TMUX_PANE` of the session's terminal when it runs inside
   * tmux. The only way the hub can type into a session it did not start.
   */
  tmuxPane?: string;
  /** `tmux` only. */
  tmuxSession?: string;
  /** `tmux` only: what was started, so a restart can reuse it. */
  argv?: string[];
  /** Boxes this session created. Reconciled on read: dropped when the box is gone. */
  boxIds: string[];
  /** Create jobs that have not produced a box yet; promoted to `boxIds` on read. */
  boxJobIds: string[];
  createdAt: string;
  lastSeenAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastExit?: number;
  /**
   * When the hosting hub last reported (`POST /managers/{id}/heartbeat`). Only
   * ever set on a hub that does NOT host this manager: its own machine reads the
   * process instead of believing a report.
   */
  reportedAt?: string;
  /** The last heartbeat's payload; read by `toManagerView` when the host differs. */
  reported?: ManagerHeartbeat;
}

/**
 * What the machine a manager runs on reports about it, so a hub that only holds
 * the record can still show a live status, title and turn. Every field is
 * derived from a probe there (`managerStatus`, `sessionTitle`, `sessionTurn`,
 * `createBackgroundSessionLookup`), never from the record.
 */
export interface ManagerHeartbeat {
  status: ManagerStatus;
  sessionId?: string;
  title?: string;
  turn?: number;
  prompt?: string;
  lastExit?: number;
  background?: ManagerBackground;
  terminalSession?: string;
  /** The tmux session that shows it right now, when one does. */
  tmuxSession?: string;
}

/**
 * A JSON-serialisable change to one record: a field set to a value, or to `null`
 * to unset it. Serialisable because the store it is applied to may be another
 * machine's — a closure could not travel.
 */
export type ManagerRecordPatch = {
  [K in keyof ManagerRecord]?: ManagerRecord[K] | null;
};

/**
 * The record a tmux start or resume produced, as the machine that ran it
 * describes it. `id` names an existing record to move; without one a new manager
 * is minted.
 */
export interface ManagerRegistration {
  id?: string;
  agent: ManagerAgent;
  kind: 'tmux';
  host: string;
  cwd: string;
  tmuxSession: string;
  sessionId?: string;
  argv?: string[];
}

/** On-disk shape of `managers.json`. */
export interface ManagerFile {
  version: 1;
  managers: ManagerRecord[];
}

/** Derived from the process (tmux session or pid), never stored. */
export type ManagerStatus = 'running' | 'stopped';

/**
 * Why a manager cannot be resumed right now. There is deliberately no
 * "other host" value: whether a client may resume a manager is `host` against
 * its own hostname, which it can answer without the hub's help.
 */
export type ManagerResumeBlock = 'running' | 'unsupported-agent' | 'no-session';

export interface ManagerView extends Omit<ManagerRecord, 'argv' | 'reported' | 'reportedAt'> {
  status: ManagerStatus;
  /**
   * Whether the hub answering this call is the machine the manager runs on. A
   * client attaches, resumes, stops or types only where this is true; against
   * any other hub those are `wrong_host`, and the client retries on the hub
   * whose hostname is `host`.
   */
  hostIsHub: boolean;
  /**
   * Whether a resume would be accepted now: false while it runs, without a
   * session id, and for an agent we cannot resume. Says nothing about WHERE —
   * that is `hostIsHub`.
   */
  resumable: boolean;
  /** Why `resumable` is false; absent when it is true. */
  resumeBlockedBy?: ManagerResumeBlock;
  /**
   * Ready-to-run attach command: a running hub-run manager's tmux session, or the
   * hub's attach session for a Claude background session while that session is up.
   */
  attachCommand?: string;
  /**
   * Set when this claude manager's session is a live Claude Code background session
   * (`claude --bg`, listed by `claude agents`). `POST /managers/{id}/attach` opens it
   * in a hub tmux session; the session itself runs in Claude's own daemon.
   */
  background?: ManagerBackground;
  /**
   * A running external manager's likely terminal: the one AgentBox tmux session
   * (`agentbox-manager-*`) that starts in its folder and no manager owns. Offered
   * to open, never adopted — nothing ties the session to this manager for sure.
   */
  terminalSession?: string;
  workspaceName: string;
  /** Tasks whose `managerId` is this manager. */
  taskCounts: { open: number; done: number };
}

/** A Claude Code background session, as `claude agents --json` reports it. */
export interface ManagerBackground {
  /** The short id `claude attach` takes. */
  id: string;
  /** `busy`, `idle`, `waiting`, … */
  status?: string;
  /** `working`, `done`, … */
  state?: string;
  name?: string;
}

/** One resumable agent session found in the host agent's own store. */
export interface HostSession {
  id: string;
  agent: string;
  title: string;
  updatedAt: string;
}

// ── timeline ──

export type TimelineEventType =
  | 'task.created'
  | 'task.status'
  | 'task.assigned'
  | 'task.unassigned'
  | 'task.removed'
  | 'manager.joined'
  | 'manager.started'
  | 'manager.resumed'
  | 'manager.stopped'
  | 'manager.note'
  | 'manager.message'
  | 'box.created'
  | 'box.ready'
  | 'box.failed'
  | 'box.started'
  | 'box.stopped'
  | 'box.destroyed'
  | 'box.branch'
  | 'git.push'
  | 'pr.opened'
  | 'pr.ready'
  | 'pr.merged'
  | 'pr.closed';

export type TimelineActor = 'human' | 'manager' | 'box' | 'hub' | 'github';

export type TimelineNoteKind = 'note' | 'replan' | 'plan';

export type TimelineChecks = 'pass' | 'fail' | 'pending' | 'none';

export interface TimelinePr {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  additions?: number;
  deletions?: number;
  checks?: TimelineChecks;
  mergeState?: string;
  autoMerge?: boolean;
  mergedBy?: string;
}

/**
 * One line of a workspace's append-only `timeline.jsonl`. Current state lives in
 * tasks/managers/boxes and is overwritten; this is the only record of what
 * happened, so every field is captured at write time rather than joined later.
 */
export interface TimelineEvent {
  /** Time-sortable: zero-padded base-36 milliseconds, then a random suffix. */
  id: string;
  at: string;
  type: TimelineEventType;
  actor: TimelineActor;
  managerId?: string;
  turn?: number;
  prompt?: string;
  boxId?: string;
  boxName?: string;
  agent?: string;
  branch?: string;
  /**
   * The branch the work started from: `box.created`/`box.ready`, the branch the
   * box forked from; `box.branch`, the branch it switched away from.
   */
  base?: string;
  projectId?: string;
  /** Captured at write time: reconciliation later clears a task's box pointer. */
  taskIds?: string[];
  task?: { id: string; title: string; from?: WorkTaskStatus; to?: WorkTaskStatus };
  pr?: TimelinePr;
  /** A note's text, or the message sent to a manager. */
  text?: string;
  noteKind?: TimelineNoteKind;
  /** `task.assigned`: the box was already running, i.e. it was given more work. */
  boxRunning?: boolean;
  /** `git.push`: lines the push added and removed, read from the host repo when it was recorded. */
  additions?: number;
  deletions?: number;
  /** Dedupe key: an append carrying a key already in the log is a no-op. */
  key?: string;
}

/** Who did something, as a mutation's caller knows it. */
export interface TimelineStamp {
  actor: TimelineActor;
  managerId?: string;
  turn?: number;
  prompt?: string;
}

/** Roll-up of a box's assigned tasks, for a box row in a list. */
export interface BoxTaskSummary {
  total: number;
  done: number;
  /** The task the box is working now (or would work next); null when all done. */
  current: { id: string; title: string } | null;
}
