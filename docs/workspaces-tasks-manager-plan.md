# Workspaces, Tasks and the Manager

## Context

Running several boxes in parallel is the point of AgentBox, but deciding *what* each one should do —
and making sure two of them do not fight over the same files — is entirely manual today. The
"Agents Manager" design (`../agentbox-design/AgentBox Tray App v2.html`) closes that: a coding agent
running **locally** in a folder reads a task list, groups the tasks into boxes so their diffs do not
collide, creates the boxes, and watches their PRs. Three things had to exist first:

1. a **Workspace** — a host folder grouping one or more projects (subfolders with a `.git` or an
   `agentbox.yaml`, or the folder itself). The existing "project" entity is one repo; the unit a
   human plans across is usually a folder holding several of them;
2. a **Task** — a unit of work both the human and the manager create and prioritize. Many tasks map
   to one box on purpose: the manager puts the three tasks that touch `src/payments` in one box and
   the two copy-only ones in another;
3. a **Manager session** — the agent process itself, running in the workspace root with the
   `agentbox` CLI on PATH.

Phase 1 (this doc's subject) builds the entities, the store, the hub API and the CLI. The GUIs and
the manager's own instructions come after.

### Decisions taken

- **Names.** "Workspace", despite the internal collision with the box's `/workspace` mount and the
  `agentbox.yaml` config scope — it is what users call the thing. "Task", despite the collision with
  the `tasks:` block in `agentbox.yaml`: Linear tickets will later map 1→n onto local tasks, and
  "ticket" would then be the wrong word for both. The TS type is `WorkTask` so it never clashes with
  `@agentbox/ctl`'s `TaskSpec`; the docs call the yaml ones **setup tasks**.
- **The hub owns the manager process**, started in a detached tmux session on the hub's machine.
  Clients attach to that session rather than the hub proxying a terminal to each of them, which is
  what lets the CLI, the tray and a plain terminal all reach the same running agent.
- **Tasks are workspace-owned** with an optional `projectId` and an optional `boxId`. A backlog item
  exists before anyone knows which project it touches; forcing a project up front would mean it
  could not.
- **Assignment is reconciled on read, never trusted.** A task assigned at create time carries a job
  id until the worker records the box; a task whose box was destroyed returns to the backlog. Status
  is never touched by reconciliation — half-finished work stays half-finished.
- **The backend is split by domain.** `apps/hub/lib/hub-backend.ts` had reached 3800 lines because
  every feature appended its methods there. This work introduced `apps/hub/lib/backend/`, where a
  slice takes a narrow `BackendDeps` instead of the relay handle.

### Status

| Phase | What | State |
| --- | --- | --- |
| 1 | Store: `~/.agentbox/workspaces/<id>/` (workspace, tasks, manager) | **done** |
| 2 | Hub: `WorkspaceBackend` slice + `/api/v1/workspaces`, `/api/v1/tasks` | **done** |
| 3 | CLI: `workspace`, `tasks`, `manager`, and `--tasks` on create | **done** |
| 4 | The manager's brief: what it is told to do with the task list | planned |
| 5 | Tray: the Manager window (task list + terminal pane) | **done** |
| 6 | Hub web UI: workspace + task views | planned |
| 7 | Linear import: one ticket → several local tasks | planned |
| 8a | Managers are detected, not declared: many per workspace, `/api/v1/managers`, `Box.managerId` | **done** |
| 8b | Tray: boxes grouped by manager, the Manager window's session picker | planned |
| 9a | Timeline: per-workspace event log, GitHub PR sync, `GET …/timeline`, manager notes and messages | **done** |
| 9b | Tray: Plan / Timeline in the Manager window, Approve → message the manager | in progress |
| 11a | Timeline as a branch graph: `lane` on timeline rows, `base`, `box.branch` | **done** |
| 11b | Tray: draw the timeline as a branch graph | in progress |

### Known gaps

- **The manager has no instructions yet.** Phase 1 starts a plain agent in the folder with
  `AGENTBOX_WORKSPACE` set and the `agentbox tasks` CLI available. What it should *do* with them (the
  file-overlap grouping, the `box.merged` follow-up) is Phase 4.
- **A codex store holds more than sessions.** Its rollouts are flat across every project, so the
  folder comes out of each file's opening record — which also marks the agent's own internal threads
  (`guardian_review`, `subagent`). Those are skipped, as claude's `agent-*.jsonl` transcripts are: on
  a real store they were 49 of 71 files, none with a turn to name them. That opening record can also
  outgrow any fixed head read, so it is read by following the line rather than a buffer, and the
  title is scraped after it. Candidates are ranked by mtime before the read budget applies, because
  a resumed session keeps appending to its original file and a name-ordered cut would drop exactly
  the ones still in use.
- **Only claude and codex can resume a session.** Each has its own spelling — `claude --resume <id>`
  against `~/.claude/projects/<encoded-root>/<id>.jsonl`, and the SUBCOMMAND `codex resume <id>`
  against the flat `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` store, which records the folder
  inside each file rather than in its path. The remaining agents' on-disk formats are unverified, so
  `GET …/managers/sessions` answers `supported: false` for them and a `sessionId` is refused rather
  than silently starting a fresh agent that looks resumed.
- **opencode and pi are never detected as managers.** Neither exports a session id into the commands
  it runs, so a create from inside one registers nothing and its boxes land in "Other boxes".
- **Codex's sandbox hides most of this.** In the default `workspace-write` sandbox loopback is blocked
  (`curl http://127.0.0.1:8787` answers nothing), so the CLI cannot reach the hub at all and detection
  fails with a warning; it needs `[sandbox_workspace_write] network_access = true` in
  `~/.codex/config.toml`, or a full-access sandbox. Even with network access, `ps` is "operation not
  permitted" there, so the ancestor walk that finds the codex pid fails soft and a sandboxed codex
  manager never has a pid: its liveness is the 30-minute `lastSeenAt` window. `CODEX_THREAD_ID` itself
  is exported (a uuid-v7, verified on codex 0.142).
- **A create registers its session only against a hub that is already up.** The registration around
  a docker/cloud create goes through `withHubClientQuiet`: no autostart, no error output, no exit
  code. With no full hub running (a lean `agentbox relay` holds the port) it is one warning, and the
  boxes land in "Other boxes" until a later `agentbox` call from that session registers it.
- **A session is only resumable where its transcript is.** An external manager reported from another
  host answers `409` on resume (`resumable: false`, `resumeBlockedBy: 'other-host'`); `resumeBlockedBy`
  is checked in the order the resume checks (`other-host`, `running`, `no-session`,
  `unsupported-agent`) so a client words its disabled button the way the error would.
- **A pid is matched with its start time.** At detect from the hub's own host the hub records
  `pidStartedAt` (`ps -o lstart=`, `LC_ALL=C`, fail soft); a live pid whose start time changed reads as
  stopped. An unreadable start time is not evidence of a new process. When the status is still wrong,
  `manager forget --force` / `workspace remove --force` (`?force=1`) pass the "is running" refusal and
  leave any process alone.
- **Titles are cached only when real.** `(untitled)` and a failed lookup are never written to the
  record; a miss is remembered in the hub's memory for 10 minutes per manager (keyed by its session
  id, so a `/clear` retries at once).
- **A remote hub probes no pid and scrapes no title.** A pid is only probed when the detect reported
  the hub's own hostname, and a title is read from the agent's store on the hub's disk; a PC session
  registered with a control box falls back to the `lastSeenAt` window and shows its short session id.
- **A remote hub's manager runs on the remote machine, and the CLI targets the laptop hub.** The
  workspace CLI commands all pass `preferLocal`, so with a control box configured the CLI and the
  tray read different stores. Superseded by
  [`workspaces-remote-hub-plan.md`](./workspaces-remote-hub-plan.md): the store moves to the hub
  that owns the boxes and the manager stays on the PC.
- **The remaining hub-backend domains are still in the monolith.** Boxes, projects, fleet ops and the
  open-in launchers should each move to `lib/backend/<domain>.ts`; the four `// ── … ──` banners in
  `hub-backend.ts` mark the seams.
- **tmux is a new soft dependency** of the hub host, for the manager only. `agentbox doctor` warns
  when it is missing and `manager start` answers 503 with an install hint. The session is created
  with `window-size latest` (best-effort), so a tray pane and a terminal attached at the same time
  size to the most recent client instead of both being clamped to the smaller grid.

---

## Phase 1 — the store (`packages/relay/src/workspaces/`)

`~/.agentbox/workspaces/<wsId>/` holds `workspace.json`, `tasks.json`, `manager.json` and
`manager.exit`. Atomic temp+rename writes under `withFileLock`, the same shape
`packages/relay/src/queue.ts` uses; the lock windows are short because these files sit on the
dashboard poll path.

`wsId = hashProjectPath(root)` — the same key space as the project registry, so a single-project
folder registered as both shares one id and a client can join the two with no lookup table.

Task ids are `T-<n>` from a counter on the workspace record, **never reused**: a stale reference in a
manager transcript or a PR body must not resolve to different work later.

The pure halves — `reconcileTasks`, `reorderTasks`, `taskSummaryForBox`, `findWorkspaceContaining` —
are separated from the IO so they are testable without a filesystem.

## Phase 2 — the hub API

`apps/hub/lib/backend/deps.ts` declares the three seams a slice gets: `notify()` (the `/api/events`
fan-out), `liveBoxIds()` (local records **union** Store registrations — a control box's PC-created
cloud box has a registration and no local record) and `jobs()`. `createHubBackend` builds them once
and spreads `createWorkspaceBackend(deps)` into the returned object; `HubBackend extends
WorkspaceBackend`, so callers still see one object.

Routes under `app/(dashboard)/api/v1/workspaces/` plus a cross-workspace `…/api/v1/tasks`. No PATCH
(this API has none anywhere): an update is a POST on the resource, and everything else is a POST
sub-resource. Every mutation calls `deps.notify()`.

Two payload fields were added, both additive and both absent on the hosted/Postgres path, where
absence means "no data", never "zero":

- `Project.workspaceId` — set when a registered workspace lists that project id.
- `Box.tasks` — `{ total, done, current }`, matched by box id and by pending create-job id (so a
  synthetic `job:<id>` row shows its tasks while the box is still being built).

`POST …/managers/start` (then `…/manager/start`) takes its accept-list from the live agent registry, minus the agents whose
`surface` is `service` and those the host reports as not installed. Anything a picker offers can
therefore be a manager, including one added by `agentbox agent add`, while a daemon-shaped agent is
refused (it has no session to attach to, so it would leave a tmux session nobody can use) and so is
one the host cannot run — unlike a box, which installs its agent on demand, the manager runs where
nothing will, and without that check the start answers 200 and the session dies with exit 127.

There is deliberately no free-form `argv` — the manager runs on the hub's own machine, so accepting
one would turn an API token into a shell on a control box. `sessionId` is constrained to an id shape
for the same reason: it lands in the agent's argv, and a value like `--dangerously-skip-permissions`
would be read by the AGENT as a flag, starting the manager with its approval gate off. Shell quoting
does not cover that; only the shape check does.

## Phase 3 — the CLI

Three thin clients over the API. Which workspace a command means resolves `--workspace`, then
`$AGENTBOX_WORKSPACE` (set inside the manager's own session, so the manager needs no flag), then the
registered workspace whose root contains the cwd, longest root winning.

`--tasks T-11,T-12` on `agentbox create` and every agent command validates the ids **before** any box
is provisioned, then assigns after: a job id where the create returns one (hub-routed and `-i`
queued creates), a box id where it returns that instead (the inline docker path, and the cloud path
via a new `onCreated` hook). Assignment failure after the box exists is a warning, never a failed
create.

## Phase 8 — managers are detected, not declared

Before this phase a manager existed only when someone registered a workspace and started an agent in
it through the hub. In practice the manager was already there: the claude or codex session in the
user's terminal that runs `agentbox create` / `agentbox claude …`. Nobody wanted to declare a
workspace first.

**A manager is a host agent session**, many per workspace, of two kinds:

- `external` — the user's own terminal process. The hub only observes it.
- `hub` — started by the hub in a tmux session it owns (`agentbox-manager-<managerId>`), as before.

When the CLI runs inside a session it sends that session's identity (`POST /api/v1/managers/detect`);
the hub registers it and, if no workspace contains the session's folder, creates one there named after
the folder — never at `/`, the hub user's home folder or a folder above it, nor at a path that is not a
folder on the hub: those answer `400` and the CLI shows the refusal as a warning (register the project
folder with `agentbox workspace add` instead). A session already registered stays in its workspace. An external manager whose process
has ended is **resumable by the hub** (`POST /managers/:id/resume` → `claude --resume <id>` /
`codex resume <id>` in the recorded `cwd`), after which it is `hub`-run — that is what turns "the
session that made these boxes" into a manager any client can reopen.

| agent | identity in the spawned shell | liveness handle |
| --- | --- | --- |
| claude | `CLAUDE_CODE_SESSION_ID` (+ `CLAUDECODE=1`) | `CLAUDE_PID` |
| codex | `CODEX_THREAD_ID` | nearest ancestor process named `codex` (none inside its sandbox) |

**Detection** (`apps/cli/src/lib/host-session.ts`) cross-checks claude's id against a transcript,
walking up from the cwd so a command run in a subfolder records the folder the session was started in
(where `--resume` finds it). Inside an Agent-tool subagent the id is the subagent's own and has no
transcript; the fallback is the single session in that folder touched in the last five minutes, else
nothing is sent. `AGENTBOX_MANAGER=<managerId>` is exported into a hub-run manager's shell, so its
agent's own `agentbox` calls join that record instead of registering a second one. Inside a box
(`AGENTBOX_RELAY_URL` set) nothing is detected. Registration is best-effort everywhere: a failure is at
most one warning, never a failed create or a changed exit code.

**Rules for a workspace the user named.** With `-w`/`--workspace` (or `$AGENTBOX_WORKSPACE`), a command
never creates another workspace: the session is only registered when the workspace containing its
folder is the named one, and a manager the hub keeps in a different workspace is not attached. The hub
enforces the same invariant: `addTask` / `updateTask` answer `400` for a `managerId` of another
workspace (or an unknown one), and a task inherits its box's manager only when that manager belongs to
the task's workspace.

**Store.** `managers.json` `{version:1, managers: ManagerRecord[]}` replaces `manager.json`, with the
same locked temp+rename writes as `tasks.json`; exit codes move to `managers/<managerId>.exit`. A
legacy `manager.json` is read once into a `hub` record — keeping its old tmux session name, so a
session still running under it reads running — and then deleted. While that record still runs under
the old name its agent writes its exit code to the old `manager.exit`, so the view and `stop` read it
there; the migration deletes that file only when it read a code from it, and the next stop drops it.
That layout exported `AGENTBOX_MANAGER=1`, which names no record, so a detect with no `managerId`
joins the single running migrated record with the same agent and folder (and no session id yet)
instead of registering a duplicate; a record on the current tmux name is never adopted this way. `status` is derived, never stored:
tmux for `hub`; for `external` a `kill(pid, 0)` (ESRCH = stopped, EPERM = running) when the detect
reported this host's name — and a live pid whose start time differs from the recorded `pidStartedAt`
counts as stopped — else running while `lastSeenAt` is under 30 minutes old.

**Boxes and tasks.** A manager keeps `boxIds` and `boxJobIds`, reconciled on read with the same rules
as a task's assignment (job → box, a failed job dropped, a gone box dropped unless a create in flight
recorded it). `POST /boxes` takes `managerId` and attaches the job; the agent commands, whose docker and
cloud paths create inline, attach through the detect call itself (`boxId` / `boxJobId` on the body).
`GET /boxes` stamps `Box.managerId`. `WorkTask.managerId` is set by `agentbox tasks add` inside a
session and inherited from the box on assignment; `?managerId=` filters both task listings.
`WorkspaceView.manager` became `managers: { running, total }`, and a workspace cannot be removed while
any of its managers runs (unless `--force`).

**API.** The three `workspaces/:id/manager*` routes are gone. `GET /managers`
(`?workspaceId=&status=`), `POST /managers/detect`, `GET|DELETE /managers/:id`,
`POST /managers/:id/{stop,resume}`, and per workspace `GET /workspaces/:id/managers`,
`POST …/managers/start` (a `sessionId` some manager holds resumes THAT manager) and
`GET …/managers/sessions`. Resume answers 409 while the session still runs anywhere and 503 without
tmux; stop answers 409 for a running external manager, whose process the hub never signals.

**Backend.** `apps/hub/lib/backend/managers.ts` (`createManagerBackend(deps, { workspaceView })`),
with `hostname` / `isPidAlive` seams on `BackendDeps` so the status matrix is testable anywhere.

**CLI.** `agentbox manager list | status [id] | start | resume <id> | stop <id> | attach [id] |
sessions | forget <id>`; `agentbox tasks list --manager <id> | --mine`. A `tasks` / `workspace` /
`manager` command in a folder no workspace contains registers the session instead of failing.

### Claude background sessions (follow-up, Phase 10)

Claude Code 2.1.270 can host a session in a daemon (`claude --bg`, or a TUI that sent its session to
the background): `claude daemon run` → `bg-pty-host` → `bg-spare`, reached with `claude attach <short
id>`. Measured on this machine, three facts shape everything below:

- `claude agents --json` lists every daemon-hosted session as `kind: "background"`, **whether or not a
  client shows it**, and nothing the daemon writes (`~/.claude/sessions/<pid>.json`,
  `~/.claude/jobs/<id>/state.json`, `daemon.log`) says which client is attached.
- The daemon drops `TMUX`/`TMUX_PANE` from the sessions it hosts, and hands **the environment of the
  client that spawned it** to every session it hosts. A `claude --bg` started from a plain shell
  saw the acme-saas manager's `AGENTBOX_MANAGER=1` / `AGENTBOX_WORKSPACE`, and not its own launcher's
  variables. The daemon is shared, so the ppid chain of a detached session can run through another
  client's tmux pane too.
- A session live in the daemon lists a `pid` and a `status`; one ended with `claude stop` (or failed)
  lists neither.

What the hub does with them:

- **Background detection** (`createBackgroundSessionLookup`, `backgroundFor` in `manager.ts`). One
  cached snapshot per hub process (15 s TTL, one read in flight, 3 s timeout): `claude agents --json
  --all`, `tmux list-sessions` (name + start folder), and `ps` for `claude attach <id>` clients when a
  session is live. Only a workspace with a claude manager on this machine asks; a missing `claude` is
  not asked again for 10 minutes. A claude manager's session is **background** when it is live in
  the daemon, no `agentbox-manager-*` tmux session other than its own attach session started in its
  folder (a TUI there may be showing it), and no `claude attach` client runs outside that attach
  session. The view carries `background: { id, status, state, name }`, and the manager is `running`
  while the daemon runs the session.
- **`POST /managers/{id}/attach`** re-checks that with a fresh snapshot, then starts (or reuses)
  `agentbox-manager-<managerId>` running `claude attach <id>` in the manager's folder, with the
  manager session options. The record only learns `tmuxSession`: kind, session id and pid stay the
  detected ones, and `attachCommand` is sent while that tmux session is up. 409 without a detached
  live session, 503 without tmux. **Stop** on such a manager kills only the attach session and
  answers `notice`; resume answers 409 while the daemon runs the session.
- **`terminalSession`** on a running external claude manager names the one unclaimed
  `agentbox-manager-*` tmux session that started in its folder — a guess the tray offers as
  *Open terminal here*, never adopted.
- **Detect.** The CLI sends `tmuxSession` when `$TMUX` is set and the pane's session is an
  `agentbox-manager-*` one; the hub records the manager as `hub`-run from it when that session exists
  here and started in the detect's folder (the owning record joins by id; an unowned session, such
  as the single-manager layout's `agentbox-manager-<workspaceId>`, is adopted). Because of the env
  leak, a `managerId` hint is believed only for a manager in the same folder that has no session yet
  or is hub-run and running.
- **Env scrub.** `scrubAgentSessionEnv` (`@agentbox/sandbox-core`) drops the agent-session variables
  (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID` and the other `CLAUDE_CODE_*` session vars,
  `CLAUDE_BG_*`, `CODEX_THREAD_ID`, `AGENTBOX_MANAGER`, `AGENTBOX_WORKSPACE`, `TMUX`, `TMUX_PANE`)
  from the hub daemon's spawn env and from a manager's tmux client env, and a manager's pane script
  starts with `unset` of the same list (a running tmux server hands its own global env to new
  sessions). A hub started from inside a claude session no longer passes that session's identity to
  the managers it runs.

**Not repaired: a session already in the daemon.** A pre-Phase-8 manager whose agent moved to the
daemon (acme-saas's kanban session, live in `agentbox-manager-1020d6ffc6aa4e07`) is still an
`external` record with the daemon pid: its `agentbox` calls cannot send `tmuxSession` (no `TMUX`), and
nothing links the session to that pane for sure. It reads running, gets no `background` (the legacy
session starts in its folder), and gets `terminalSession`, which the tray opens on request.

## Phase 9 — the timeline

The Manager window shows what is planned and the manager's terminal. The timeline shows what
happened: which boxes a manager started, what merged, which tasks finished, when it re-planned and
why, when a running box was given more work. Nothing recorded that before — tasks, managers and box
records are current state whose timestamps are overwritten, and the relay's event ring is in memory
and per box — so this phase adds an append-only log per workspace and writes to it at every mutation
point.

**The log.** `~/.agentbox/workspaces/<id>-<slug>/timeline.jsonl`, one `TimelineEvent` per line
(`packages/relay/src/workspaces/timeline-store.ts`). An append takes the workspace lock and is one
`appendFile`. Past 5000 lines, or once the oldest event is over 90 days old, the file is rewritten
(temp+rename) keeping the newest 4000 events inside the window — below the trigger, so a full log is
not rewritten on every append. Reads order by `at`, not by append order: a merge the GitHub sync finds
late carries the time it merged. Several processes append (the hub, the relay's RPC handlers, a queue
worker), so the in-memory index of dedupe keys is refreshed from the bytes past its last offset on
every use, and rebuilt when the inode changes (a compaction). Every writer except the note route is
best-effort: a log failure never fails the mutation that already happened.

**Who.** Every event has an `actor`: `human`, `manager`, `box`, `hub` or `github`. The CLI sends
`X-AgentBox-Session: <agent>:<sessionId>` on every request when it runs inside a host session (detected
once per process, without the `ps` walk); the hub resolves it to a manager of the route's workspace
without writing and stamps `managerId`, `turn` and `prompt`. `sessionTurn` (`manager.ts`) reads the
transcript incrementally from a per-file offset — claude: a new `promptId` on a `user` row that is
neither meta nor tool results only; codex: a `turn_context` row, with the prompt from the last
`user_message` — and only when the store is on the hub's disk (the same rule as the title). No header
(the tray, the web UI) is `human`. A route that does not name a workspace (box create, lifecycle and
git; manager message, stop and resume) carries the session unresolved, and the backend resolves it in
the box's or manager's own workspace: a manager of another workspace is recorded as `human`, never
stamped into this log.

| Event | Written by |
| --- | --- |
| `task.created/status/assigned/unassigned/removed` | the workspace slice's task methods. `assigned` carries `boxRunning` ("gave more work to a running box"); `reorder` records only its note |
| `manager.joined` | detect, only for a new record or a new session id on one |
| `manager.started/resumed/stopped` | the manager slice (stop only when the session was running) |
| `manager.note` | `POST /managers/{id}/notes`, and `note` on task create/update/assign/reorder bodies (`replan` for a reorder) |
| `manager.message` | `POST /managers/{id}/message` |
| `box.created` | the hub's create, key `job:<jobId>:created`, stamped with the manager the create names (`managerId`) when it belongs to the workspace, else with the caller's session |
| `box.ready/failed` | the queue worker at a create job's terminal status, and the queue loop when a worker cannot start or dies (key `job:<jobId>:ready\|failed`) |
| `box.started/stopped/destroyed`, `git.push` | the hub's box lifecycle route and git route (`push`, `push-host`), wrapped in `withBoxTimeline`. Written in the background after the operation answered, from the box's `state.json` record by id (read before a destroy, which removes it); nothing is read when no workspace exists. `task.assigned` is written the same way |
| `git.push` (from a box) | the relay `git.push` RPC, docker and cloud, unless it is host-only or carried a host-initiated token the relay validated and consumed — those came through the hub route, which recorded the real caller. A `hostInitiated` param the relay rejected or never checked does not skip the event |
| `pr.opened/merged` (from a box) | the relay `gh` shim after an exit-0 `gh pr create` / `gh pr merge`, read back with `gh pr view` (scoped with the merge's `-R`/`--repo` when it named one) |
| `pr.opened/ready/merged/closed` | the GitHub sync |

**Dedupe.** A PR event's key is `pr:<owner/repo>#<n>:<opened|ready|merged|closed>`, built by one
function (`prTimelineEvents` in `timeline-pr.ts`) for both the shim and the sync, so a merge reported by
both lands once.

**GitHub sync** (`apps/hub/lib/backend/github-prs.ts`). `GET …/timeline` starts one in the background
when the last is over 60 s old; one runs per workspace at a time, and rows it appends fire `notify()`.
It collapses the workspace's project folders to the GitHub repos behind them (`gh repo view`, cached),
runs `gh pr list --state all --limit 50 --search updated:>=<workspace created>` per repo, and keeps a
PR whose head branch the workspace knows (a box's branch, or any branch on a logged event) or whose
author is the `gh` user — the second rule is how the manager's own host-side PRs get in. `pr.ready` is
open, checks passing, and `mergeStateStatus` CLEAN or HAS_HOOKS. Without `gh`, logged out, or with no
GitHub repo, the response says `github: 'unavailable'`.

**Reading** (`apps/hub/lib/backend/timeline.ts`). `GET /workspaces/{id}/timeline?before=&limit=&since=`
answers `{ items, live, summary?, github }`. Items collapse 3+ `task.created` from one manager turn
within 10 minutes into one `plan` (`count`, `taskIds`, `prompt`), drop a move to `in_progress` within a
minute of that task's assignment, and mark a `pr.merged` preceded by a message about it
`approvedByYou`. `live` is built at read time and never stored: one row per box with an in-progress
task (plus `git diff --shortstat` of a running box, run for every box in parallel and cached 60 s; a
read that waits over 3 s gets the row without the diff, and the still-running exec answers a later
read) and one per `pr.ready` not merged or closed since (`awaiting`, and `approved` once a message about
it exists), minus a PR the last sync saw go red. PR states live in the hub's memory, so after a restart,
until a sync of that workspace completes, a ready PR no sync has confirmed is left out of `live` and of
`summary.awaiting`. An item or live row that names a branch (a PR row's `pr.head`, else `branch`) gets
`branchUrl` at read time: the repo from `pr.url`, else a repo the sync resolved, else the row's project
or box folder looked up in the sync's `gh repo view` cache — the read never runs `gh`, so a project not
yet synced has no link. `summary` counts merges and their +/−, tasks done, and what awaits you (unapproved ready PRs
plus pending approvals on the workspace's boxes) since `since`.

**Approve does not merge.** The tray's Approve posts `POST /managers/{id}/message {text, prNumber?, repo?}`,
which types the text into the manager and submits it — a running hub-run manager's tmux session, a
running external manager's `$TMUX_PANE` (recorded at detect when `$TMUX` is set, and only reachable on
the hub's machine), or a stopped manager resumed in the hub's tmux with the text as its prompt — and
the manager merges. The text is typed with `send-keys -l --` (so a leading `-` is not a flag), newlines
flattened, a trailing `;` escaped (tmux reads it as a command separator), and submitted with a
separate Enter after a short pause (the agent TUIs keep an Enter inside a key burst as a newline).
`repo` (`owner/name`) pins the PR the message is about; with only `prNumber` it is tied to a PR only when
one repo in the log has that number, since a workspace can span several repos. A
resume's prompt that starts with `-` gets a leading space so the agent cannot parse it as a flag.

**CLI.** `agentbox manager note "<text>" [id] [--replan|--plan]`, and `--note` on
`tasks add | update | assign | reorder`. There is no timeline command: the hub API and the tray read it.

### Known gaps (Phase 9)

- **GitHub remotes only.** A project whose remote is not on GitHub gets no PR rows.
- **A turn needs a local store.** A manager whose transcript is on another machine is stamped with its
  id but no turn or prompt.
- **An external manager outside tmux can't receive a message.** The route answers 409
  `manager_unreachable` and the client offers the text to paste. A pane is addressed on the hub user's
  default tmux server.
- **Merges done by hand on github.com show up only for known branches or PRs by the gh user**, and only
  on the next sync, which runs when the timeline is read.
- **The log cannot un-append.** A PR logged `pr.ready` that later went red stays in the history; the
  live row follows the last sync, whose PR states live in the hub's memory and are empty after a
  restart until the next sync.
- **A message typed into a session showing a dialog answers the dialog.** Verified: a hub-run claude
  in an untrusted folder sits on its trust prompt with "No, exit" selected, and the message's Enter
  exits the agent. The hub does not read the pane before typing; a manager runs in a folder it trusts.
- **`box.started` records the request**, including one for a box that was already running.
- **Relay-side writes fire no change event.** A push or PR from a box shows on the next poll or the
  next hub-side change.

Open work after Phase 9 is tracked in [`workspaces-tasks-manager-backlog.md`](./workspaces-tasks-manager-backlog.md).

## Phase 11 — the timeline as a branch graph

The Manager window draws the timeline like a git graph: each box is a coloured lane that forks off the
line it started from, runs beside the others, and merges back into its pull request's base. The hub
decides the lanes, so a web view gets the same graph; the tray only packs lanes into columns and
draws them.

**What is recorded.**

| Field / event | Written by |
| --- | --- |
| `base` on `box.created` | the hub's create: `fromBranch`, else the branch the project's host checkout is on (`git symbolic-ref --short HEAD`, 1 s, through `BackendDeps.projectBranch`). Absent on a detached HEAD or any failure; never fails the create |
| `base` on `box.ready` | the queue worker, from the job's `createOpts.fromBranch` when it has one |
| `box.branch` `{boxId, boxName, branch, base?}` | `withBoxTimeline` around `gitCheckout` and `gitNewBranch`, when the box ends up on another branch. The route sanctions the branch `git symbolic-ref` names after the op, and the row takes it from the re-read record: a checkout with `args` (paths) records and sanctions nothing, and one that detaches HEAD (a SHA, a tag, `origin/foo`) sanctions nothing, so it writes no row. `base` is the branch the box left. No dedupe key |

The relay has no in-box checkout RPC. A switch made inside the box shows only when a later push or PR
names the new head.

**Lanes** (`apps/hub/lib/backend/timeline-lanes.ts`, pure). `getTimeline` aggregates the whole log,
builds the live rows, and calls `assignLanes` before `before`/`limit` apply, so ids are stable across
pages. The walk runs oldest to newest and stamps `lane: {id, kind, from?, into?, branch?, open?}` on
every item and live row:

- **`id`**, first match wins:
  - `box:<boxId>`, from the row's `boxId` or its job key. `box.created` has no box id, but its job's
    `box.ready`/`box.failed` does.
  - For `pr.*` and `git.push`, the lane that last carried the head branch.
  - `branch:<head>` for a PR.
  - Otherwise `trunk`: tasks without a box, managers, notes, plans, and a create whose job has not
    finished.
- **`from`**, on a lane's oldest row: the box lane that last carried the lane's `base`, else `trunk`.
  A PR lane uses `pr.base`.
- **`into`**, on `pr.merged`: the box lane carrying `pr.base`, else `trunk`. The row stays on its own
  lane.
- **`branch`**, on the first row and wherever the lane's branch changes: `box.branch`, or a push or PR
  on a new head after a merge.
- **`open`**, on every live row, and on the lane's newest item when the lane goes on. That is when a
  live row exists, or the box still exists and either is running or its last work was not a merge or
  a close (start and stop rows don't count as work).

Trunk branches are known before the walk: every `base` and `pr.base` that is not some box's own
`box.created`/`box.ready` branch (`main`). No box ever carries one, so a box that checks out `main`
does not become the parent of later forks and merges. A PR merged back into its lane's own earlier
branch has no `into`.

**Known gaps.**
- A multi-repo workspace shares one trunk.
- A create whose job has not finished sits on the trunk until its `box.ready`.
- A branch lane that merged and gets a new PR on the same head reuses its lane without a new fork.

## Files to touch (representative)

- `packages/relay/src/workspaces/{types,workspace-store,task-store,manager}.ts` + `index.ts`
- `apps/hub/lib/backend/{deps,workspaces}.ts`; `apps/hub/lib/boxes/{types,backend-types}.ts`;
  `apps/hub/lib/hub-backend.ts` (compose + the two `getData` hooks)
- `apps/hub/app/(dashboard)/api/v1/workspaces/**`, `…/api/v1/tasks/route.ts`, `…/lib/{validate,openapi,envelope}.ts`
- `apps/cli/src/control-plane/hub-api-client.ts`; `apps/cli/src/lib/{workspace-ref,tasks-assign,text-table}.ts`;
  `apps/cli/src/commands/{workspace,tasks,manager}.ts`; `apps/cli/src/{index,help}.ts`
- `apps/cli/src/commands/create.ts`, `apps/cli/src/agents/command/{options,create-action}.ts`,
  `apps/cli/src/commands/_cloud-agent-create.ts` (the `--tasks` seam)

## Verification

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @agentbox/hub build:standalone
AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart
ps -p <pid> -o args=            # confirm the fresh bundle is the one running
```

Then, against the local hub:

```
agentbox workspace add ~/Projects/AgentBox     # multi-project: subfolders discovered + registered
agentbox tasks add "Retry failed charges"      # resolves the workspace from the cwd
agentbox create -y -n wstest --tasks T-1,T-2   # assigned to the job, healed to the box id
agentbox tasks list --by-box                   # grouped like the design
agentbox tasks done T-1                        # GET /api/v1/boxes shows tasks {total:2, done:1}
agentbox destroy wstest -y                     # tasks return to the backlog, status untouched
agentbox manager start --agent claude --new    # tmux capture-pane shows the agent really running
agentbox manager stop
```

A `curl -N …/api/events` alongside any of the mutations above must emit a `change` event.
