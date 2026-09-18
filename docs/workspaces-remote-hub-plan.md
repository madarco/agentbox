# Workspaces, tasks, manager and timeline on a remote control box — plan

Status: **Phases 1-4 done** (2026-09-18); the remote test pass (`hub-testing.md` §F) is what
remains. One phase per session: branch off origin, implement, gates + smoke, `/code-review medium`,
merge into `feat/workspaces-remote-hub`. Phases 2–4 also gate on a **real Hetzner control box** (see
Verification).

Related: [`workspaces-tasks-manager-plan.md`](./workspaces-tasks-manager-plan.md) (the feature as
shipped in 0.32.0), [`workspaces-remote-hub-backlog.md`](./workspaces-remote-hub-backlog.md) (the
0.31 remote gaps this plan deliberately leaves alone), [`hub-testing.md`](./hub-testing.md) (the
control-box test environments).

## Context

0.32.0 shipped workspaces/tasks/manager/timeline as a local-hub-only feature: the store is on the hub
process's disk, keyed by a hub-side realpath hash, and the hub validates every folder against ITS
filesystem. With a control box configured (`relay.controlPlaneUrl`) the CLI still sends every
workspace/tasks/manager call to the laptop hub (`preferLocal: true`), the tray follows `hub target`
and reads the control box's empty store, and timeline rows for cloud boxes (push, PR, lifecycle,
viaHub create) are written on the control box and dropped because no workspace exists there. The
control box exists so boxes keep working with the PC off, so the store cannot live on the PC.

### Decisions (2026-09-15)

1. The store (workspaces, tasks, timeline, manager records) lives on the hub that owns the boxes.
   With a control box configured that is the control box. The local hub forwards its own events.
2. A workspace is repo-URL based (name + projects with repo URLs + per-host folder mapping). The
   folder scan runs CLI-side on the PC. The id is no longer a hub-side path hash.
3. **The manager runs on the PC only.** Start/resume/stop/attach/sessions/message need the folder,
   tmux and the transcripts, so they run on the PC's local hub. The record, notes, messages, turn
   metadata and timeline rows go to the configured hub. The control box never spawns a manager.
4. Push +/- counts and PR sync must not need a checkout on the hub.
5. The 0.31 remote gaps (`--model-auth` via hub, openclaw create routing, `git` routing for docker
   boxes, backup path guard, `POST /boxes/{id}/open` on an exposed Mac, `doctor --json`) are out of
   scope: documented in the backlog only.

### Facts the design rests on

- Box registrations carry `originUrl` (`packages/relay/src/types.ts`), so a control box can join a
  box to a repo-URL workspace without a folder. The control box already models projects as repos
  (`projectRepoUrl` in `apps/hub/lib/hub-backend.ts`).
- Boxes know nothing about workspaces/tasks; every join is host-side (`workspaceForPath`,
  `task.boxId`/`boxJobId`). Writers: `apps/hub/lib/backend/timeline.ts` (`withBoxTimeline`),
  `packages/relay/src/timeline-hooks.ts` (relay RPC hooks + queue worker), `managers.ts`,
  `workspaces.ts`, `github-prs.ts`.
- The hub web UI has no workspace pages, so no proxy backend is needed on the local hub.
- Docker is hidden under a control box unless `hub.mode=local`
  (`apps/cli/src/control-plane/remote-hub.ts`), so docker-box forwarding is an edge path.
- Remote-aware seams to reuse: `resolveHubTarget(url,{preferLocal})` → `onThisMachine`
  (`apps/cli/src/commands/hub.ts`), `remoteHubConfigured` (`remote-hub.ts`), hub-side
  `resolveRemoteHub()` (`apps/hub/lib/remote-hub.ts`), `storeIsLocal(rec)` guards in
  `apps/hub/lib/backend/managers.ts`, `host === hostname()` pid guards, create-preflight's explicit
  `unavailable` shape, backend slices under `apps/hub/lib/backend/<domain>.ts`.

One predicate, defined once: **workspaces live on the configured hub** = `remoteHubConfigured(cfg)`
on the CLI, `resolveRemoteHub()` on the hub (minus its `cloud.viaHub` clause). A `hub expose`-d
machine is its own control box and never forwards, which is what makes it the cheap test bed.

## Phase 1 — Repo-based workspace record (local parity first) + backlog doc — DONE

Goal: new record shape and id; scan moves to the CLI; hub stops stat'ing paths; every box→workspace
join goes by repo URL / (host, folder). Local-only mode behaves exactly as today.

As landed, the box join is **folder first, repo second** — the reverse of the bullet below. A repo
is a weak identity (two workspaces can legitimately list one; a smoke run hit exactly that and sent
`box.destroyed` to whichever record sorted first), while a folder under a workspace root names the
actual working copy and the longest root wins. The repo remains the only key that works from a
machine with no checkout, which is all Phases 2–4 need of it. Three further details differ: `workspaceForBox(records, key, localHost?)`
takes the reading hub's own hostname as a third argument (a key with no `host` names a path on it,
so a fact built without one still joins by folder); the API view keeps `projects` and `hosts` as
well as the derived `projectIds`/`root?`; and `projectIds` is the union of the repo-keyed project
ids AND `hashProjectPath(folder)` for every folder the reading hub has, because a box record and
the project registry key by folder. `findWorkspaceContaining(records, path, host)` took a host
argument rather than being replaced.

- `packages/relay/src/workspaces/types.ts`: `WorkspaceRecord { version: 2; id (16 hex random, same
  generator as manager ids); name; projects: { id, name, repoUrl? }[]; hosts: Record<hostname,
  { root, projectRoots: Record<projectId, absPath>, seenAt }>; taskCounter; … }`. API view adds derived
  `projectIds` (keeps `Project.workspaceId` / `Box.tasks` joins) and `root?` = the hub host's own
  mapping. Project id = `hashProjectPath(normalised repoUrl)` when a remote exists, else
  `hashProjectPath(host + ':' + folder)`.
- `workspace-store.ts`: new pure `workspaceForBox(records, { originUrl?, host?, projectRoot? })`
  (host+folder match first, then origin). Replaces `workspaceForPath` /
  `findWorkspaceContaining(projectRoot)` in `timeline-hooks.ts`, `apps/hub/lib/backend/timeline.ts`,
  `github-prs.ts`. `TimelineBoxFact` gains `originUrl?`/`host?`; `box-facts.ts` fills them (reuse
  `hostOriginOf`; Store-only boxes use `reg.originUrl`). Repo URLs are normalised once
  (ssh/https/`.git` spellings) in one helper next to `parsePrUrl`.
- API (`validate.ts` `parseWorkspaceAdd`, `parseManagerDetect`, `openapi.ts`): `POST /workspaces`
  body `{ name?, host, root, projects: [{ path, name, repoUrl? }] }`, idempotent by id → (host, root)
  → shared repoUrl (merge the host mapping). `POST …/rescan` removed (the CLI re-posts).
  `POST /managers/detect` adds `projects` + `home` so the folder rules in `autoWorkspaceRefusal` work
  on CLI-sent facts; "folder does not exist on this hub" goes away. `addWorkspace` drops
  `existsSync/statSync`; `registerProject` only for paths on the hub's own host.
- CLI: `workspace.ts` scans with `scanWorkspaceProjects` + `readGitOriginUrl` and posts;
  `workspace-ref.ts` and `tasks-assign.ts` match cwd against `hosts[hostname()].root`;
  `host-session.ts` `registerHostManager` sends the scan.
- Migration on read in `readWorkspace`: a version-less record → `hosts[hostname()]` from
  `projectIds` via the project registry (`listProjectsConfigured` has folder + originUrl); written
  back on the next locked write. Tasks/managers untouched.
- Task reconcile (`task-store.ts`): a `boxId` the hub does not know is no longer "gone". Drop the
  assignment only on an explicit destroy (the destroy route / a `box.destroyed` event) or a failed
  job. This is what lets a `hub.mode=local` docker box keep its tasks on the control box without any
  host inventory report.
- Backlog doc: `docs/workspaces-remote-hub-backlog.md` (the 0.31 remote gaps, with file refs),
  linked from `CLAUDE.md`; the two remote bullets in the 0.32 plan's "Decisions taken" point here.
- Docs: `openapi.ts`, `apps/web/content/docs/api.mdx` (Workspaces), `cli.mdx`.
- Tests: `packages/relay/test/workspace-store.test.ts` (`workspaceForBox` matrix: origin, host+folder,
  literal `/workspace` + origin, hub-worker clone path + origin, no match; v1→v2 upgrade; repo URL
  normalisation), `apps/hub/test/backend-workspaces.test.ts` (add with projects, idempotent merge),
  `apps/cli/test/workspace-ref.test.ts`, reconcile unit test.

## Phase 2 — CLI routes to the configured hub; the local hub forwards its events — DONE

Goal: with a control box configured the CLI and the tray read one store; cloud-box rows land where
the boxes are; docker/queue events from the PC hub are forwarded losslessly.

As landed, four details differ:

- The sink is `{ kind, record(wsId, input), workspaceFor(key, localHost?) }`
  (`packages/relay/src/workspaces/timeline-sink.ts`), installed per process by
  `configureTimelineSink(sink | null)` and chosen by `configureTimelineSinkFromConfig({ warn })` —
  ONE selection rule, called by the hub at start and by the queue worker. The control-box resolver
  moved to `packages/relay/src/workspaces/control-box.ts` (`resolveControlBox({ requireViaHub })`);
  `resolveRemoteHub()` in `apps/hub/lib/remote-hub.ts` is now that call with the `cloud.viaHub`
  clause, and is the only caller that keeps it.
- `agentbox create`'s local path could not simply drop `preferLocal`: the same `withHubClient` block
  held the tasks preflight, the session registration AND `createBox`, and a docker box cannot be
  built by the control box. The store calls moved into their own `workspaceHub()` block, which only
  fails the create when `--tasks` was asked for. Since the review pass (2026-09-18) they are two
  calls, because they are worth different things: the `--tasks` preflight stays LOUD (a bad id must
  cost nothing and fail the create), while the session registration is bookkeeping and goes through
  `withHubClientQuiet` — the same reason `runAgentCreate` always did. Under the loud client an
  unreachable control box left a plain `agentbox create` printing "box ready" and exiting 1.
- `fromBranch` is defaulted to `readCurrentBranch(projectRoot)` on the **repo-routed** creates only
  (`_cloud-agent-via-hub.ts` ×2, `create.ts`'s `--via-hub` path). The `projectId` create keeps
  `deps.projectBranch`: the hub resolving it holds that folder, and sending the ref would add the
  create route's `git fetch origin <ref>` (15 s bounded) to every local create for a value the hub
  already has.
- `withBoxTimeline`'s create hook needed one new seam, `deps.projectRoot(projectId)`: a project id is
  a hash of the local path and means nothing on the control box, so a local-record miss now falls
  back to the sink joined by `{host, projectRoot}` / `{originUrl}`.

- CLI routing: drop `preferLocal: true` in `workspace.ts` (all), `tasks.ts`, `create.ts`,
  `create-action.ts`. One helper `workspaceHub()` in `workspace-ref.ts` returns the options so the
  choice lives in one place. `manager.ts` keeps `preferLocal` until Phase 3.
  `_cloud-agent-via-hub.ts` already targets the remote; its registration now succeeds (Phase 1
  removed the folder check) and the duplicate local registration in `recordCreate` goes away.
- Timeline sink (`packages/relay/src/workspaces/timeline-sink.ts`, new): all `recordTimelineEvent`
  callers in `timeline-hooks.ts`, `withBoxTimeline`, `workspaces.ts`, `managers.ts` and the queue
  worker (`apps/cli/src/commands/_run-queued-job.ts`) go through it. File impl = today's code;
  remote impl = `POST /api/v1/workspaces/{id}/timeline/events` (new route; body
  `TimelineEventInput`, `actor` limited to `box|hub|manager`, `key` honoured for dedupe) with a
  30 s-cached `GET /workspaces` for the join. Configured from `resolveRemoteHub()` at hub start and
  from config in the queue worker; a warning in the job log when remote and unreachable.
- Control-box create hooks: `hub.create` records `box.created` via
  `workspaceForBox({ originUrl: input.repoUrl })` (landed in Phase 1's review fixes);
  `apps/hub/lib/hub-worker.ts` `completeCreateJob` records `box.ready|failed` (`key job:<id>:*`).
  The queue-side seam still keys only on `{host, projectRoot}`, so `QueueJobCreateOpts` /
  `CreateJobRow` must carry `repoUrl` for `recordCreateJobTimeline` to make the same join. `base`: the CLI sends `fromBranch` on every
  hub-routed create (default `readCurrentBranch(projectRoot)`); `deps.projectBranch` stays as the
  local fallback.
- Turn stamping from the PC: `HubApiClient` sends `X-AgentBox-Session-Turn: <turn>[;<prompt>]`
  computed by `sessionTurn` where the transcript is; `api/v1/lib/actor.ts` uses it only when the
  session resolves to a manager of that workspace and `storeIsLocal` is false.
- Docs: new route + header in `openapi.ts`/`api.mdx`; `deployed-hub.mdx` paragraph "workspaces live
  on the control box"; `hub-testing.md` new section with the manual matrix.
- Tests: `timeline-hooks.test.ts` (sink swap, dedupe on retry), `backend-timeline.test.ts` (remote
  sink route, actor limits), `apps/cli/test/with-hub` (`workspaceHub()` never prefers local).

## Phase 3 — Manager on the PC, record on the hub — DONE

As landed, seven details differ:

- The store seam (`packages/relay/src/workspaces/manager-store.ts`) is
  `{ kind, listManagers, readManagers, readWorkspace, findManager, findManagerBySession,
  registerManager, reportManager, patchManager, upsertDetectedManager, removeManagerRecord,
  managerViews, managerView }`, installed per process by `configureManagerStore` and chosen by
  `configureManagerStoreFromConfig()` — the same one rule as the timeline sink, off the same
  `resolveControlBox()`.
- It grew three methods the bullet below does not name, each forced by something the PC hub cannot
  read locally: **`readWorkspace`** (a start needs the workspace's folder ON THIS MACHINE, and the
  workspace record is on the control box — it answers the narrow `ManagerWorkspace`, since the API
  view has no `taskCounter`), and **`managerViews`/`managerView`**, because rendering a view needs
  the workspace name, the tasks and every other host's heartbeats. A remote store answers those from
  the control box's own routes; the file store answers `null`/`undefined`, meaning "render it here".
- `startManagerSession` returns a `ManagerRegistration` (the register-route body) rather than a bare
  patch: a start can MINT a record, which a patch cannot express. `resumeManagerSession` returns the
  same and now takes the record, not `(wsId, id)`. `stopManagerSession` / `attachBackgroundSession` /
  `detachBackgroundSession` return a `ManagerRecordPatch` — `{ field: value | null }`, serialisable
  because the store it is applied to may be another machine's.
- The remote store's `patchManager` is a deliberate no-op and `removeManagerRecord`/
  `upsertDetectedManager` refuse: the control box takes only `register`, `detect` and `heartbeat`
  from another host. The one thing this loses is `attachBoxToManager` on a PC hub that builds a
  docker box under `hub.mode=local` — the manager's `boxIds` does not learn about it (the task→box
  join, which is what the UI reads, is unaffected because it goes through the task store). Noted in
  `workspaces-remote-hub-backlog.md`.
  **Those two refusals are now SURFACED** (review pass, 2026-09-18): `removeManager` returns the
  store's `false` as an error naming the hub that holds the record instead of answering `ok` for a
  record that survives, and `detectManager` refuses up front rather than letting the store's
  rejection become an unhandled 500 on `POST /managers/detect`. A client pointed at the local hub
  (the tray, a script, `--url`) gets a usable answer in both cases.
- Also from that pass: a `manager.started` / `manager.resumed` row is written by exactly ONE hub.
  The control box's register route already records it where the workspace is, so the PC hub only
  forwards the row when its own store is the file one — both were logged twice. And a start whose
  registration is refused now kills the tmux session it just opened: the agent was left running with
  nothing pointing at it, and every retry minted a new id and a second session in the same folder.
- The heartbeat carries `tmuxSession` as well as the listed fields, so a background session a PC
  attached to still renders an `attachCommand` on the control box.
- `manager message` is a NEW CLI command, and it is the one op that goes to the **configured** hub
  first (not `preferLocal`): the message is a timeline row, and the retry rule the plan asks for only
  ever fires if the first attempt can be refused. `runsHere(m)` and `retryOnLocalHub(err)` are
  exported from `apps/cli/src/commands/manager.ts` for the test and for the tray's contract note.
  The retry itself is `sendManagerMessage(send)` (review pass, 2026-09-18): `withHubClient` REPORTS a
  `HubApiError` and sets `process.exitCode` rather than rethrowing, so a `try/catch` around it never
  fired — the refusal has to be caught inside the callback and handed back as a value.
- A record written before this phase is migrated on read (`kind: 'hub'` → `'tmux'`, a missing `host`
  → the reading machine's), the same shape Phase 1 used for v1 workspaces. That is a data migration,
  not an API alias: `'hub'` is gone from every type, route and client.

Goal: process ops run only on the hub whose hostname equals the record's `host`; everything else
lives on the configured hub.

- `types.ts`: `host` required on every `ManagerRecord`; `kind: 'external' | 'tmux'` (rename of
  `hub`, no alias); `ManagerView` adds `hostIsHub: boolean`; `resumeBlockedBy` drops `'other-host'`
  (clients compare `host` to their own hostname).
- Record-store seam in `packages/relay/src/workspaces/manager.ts`: `startManagerSession` /
  `resumeManagerSession` / `stopManagerSession` / `attachBackgroundSession` return a record patch
  instead of writing `managers.json`; the caller persists through `ManagerRecordStore`
  (`readManagers | findManager | patchManager | upsertDetectedManager | removeManagerRecord`), file
  impl (today) or remote impl over `/managers…` plus one new route
  `POST /workspaces/{id}/managers/register` (`{ id?, agent, kind:'tmux', host, cwd, tmuxSession,
  sessionId?, argv? }` → record + `manager.started|resumed`). `createManagerBackend(deps, { store })`.
  The legacy `manager.json` / `agentbox-manager-<wsId>` adoption paths are deleted in the same session.
- PC hub with a control box: `store = remote`, probes/tmux/transcripts local. The CLI's `manager.ts`
  keeps `preferLocal: true` for start/resume/stop/attach/sessions/message; `hubIsLocal()` becomes
  `m.host === hostname()`; list/status go to the configured hub.
- Control box: `409 wrong_host` (`details: { host }`) for start/resume/attach/stop-of-a-tmux/sessions
  when `host !== hostname()`; `sendManagerMessage` types only when `storeIsLocal`, else
  `manager_unreachable` with `details.host`. The CLI retries against its local hub when
  `details.host === hostname()`. `agentbox hub target --json --local` is added for the tray.
- Liveness/title/turn from the PC: the PC hub posts `POST /managers/{id}/heartbeat`
  (`{ status, sessionId?, title?, turn?, lastExit?, background?, terminalSession? }`) from its existing
  probes every 30 s and after mutations; `viewsOf` uses reported values when `!storeIsLocal(rec)`,
  falling back to the `lastSeenAt` window after 3 missed heartbeats. Registration and heartbeats are
  the only manager writes the control box accepts from another host.
- Docs: Manager schema (`host`, `hostIsHub`, `kind`), `register` + `heartbeat` routes, `wrong_host`;
  `api.mdx` Managers; `cli.mdx`; tray contract note in `../agentbox-tray/CLAUDE.md` (text only).
- Tests: `backend-managers.test.ts` (`wrong_host` matrix, remote store stub, view uses heartbeat when
  host differs), `manager.test.ts` (start/resume return patches), CLI message-retry rule and
  `hubIsLocal` by host.

**Verified locally (2026-09-18, no control box):** the standalone hub rebuilt and restarted with
`AGENTBOX_HUB_BIN`, then in `../agentbox-test-repo`: `manager start --agent claude` →
`manager list` shows it `running`, `kind: tmux`, `host` = this Mac, `hostIsHub: true`; `manager note`
records; `manager stop` → `stopped`; `manager forget` drops it. The store selection resolves to
`file` with no control box, so no heartbeat loop starts — the remote half is covered by the unit
suites and by `hub-testing.md` §F (F8–F13), which needs an exposed or deployed hub.

## Phase 4 — Push +/- and PR sync without a checkout — DONE

As landed, five details differ:

- The box-side stat seam keys on a BOX ID, not a fact: `boxPushStat(boxId, { before? })`
  (`BackendDeps`, implemented in `box-facts.ts` off `provider.exec` + `BOX_WORKSPACE`). The relay
  needs the same reader for the `git.pushed` report and has no provider modules at all — it never
  creates or drives a box — so `packages/relay/src/workspaces/push-stat.ts` also holds a
  process-level `configureBoxPushStat(fn | null)` / `boxPushStat()`, installed by `createHubBackend`.
  A standalone relay leaves it unset and a push it cannot read on disk simply gets no diff.
  The measurement itself is `boxPushLineStat(exec, { before?, timeoutMs? })` — the same rule as
  `pushLineStat` (old tip when it is still an ancestor, else the merge base), over
  `origin/HEAD → origin/main|master → main|master`, under one 2 s budget across every exec.
- `pushStatBefore` now answers a `PushStatSource` union (`host` with today's `PushStatInput`, or
  `box`), resolved after the op rather than before it: only the host half has to read a ref before
  the push moves it. The host half runs when the fact names no host or this one AND the folder is
  still there — a fact built here always carries this hostname, so the folder check is what
  actually decides.
- `git.pushed` is handled in BOTH `server.ts` (a box reaching a host relay directly) and
  `executeCloudAction` (a box-mode relay parks it on the HostActionQueue), because a cloud box takes
  either path. `recordBoxPushed` validates `after`/`before` as shas and the branch as a ref name,
  falling back to the host-sanctioned branch, and keys the row `push:<boxId>:<after>`. It records
  and nothing else: no git runs, and `hostRepoUnavailableReason` is untouched.
  `agentbox-ctl git push` sends it after BOTH direct-mode and leased pushes, silently (a new
  `quiet` option on the ctl RPC poster) and capped at 5 s, so a box with no relay just logs nothing.
- **`deps.projectBranch` stays.** Phase 2's `fromBranch` default covers the repo-routed creates
  only; a local `projectId` create sends `fromBranch` just when the user asked for a base
  (`resolveBranchSelection` returns `{}` otherwise), so the hub's own folder is still the only
  source of `base` on those rows — and it is the same folder the box is built from. Commented in
  place.
- Backlog item 12 is FIXED, not deferred: `ManagerRecordStore` grew `attachBox(wsId, id, target)`
  behind a new `POST /managers/{id}/attach-box`, and `attachJob` became
  `attachManagerBox(managerId, target)`. That makes three writes a control box takes from another
  host; the third is the narrowest of them (one id appended to a list, nothing moved or removed).

One behaviour change worth knowing: a workspace project with no `repoUrl` no longer syncs PRs. A v2
record gets it from the CLI scan and a v1 upgrade from the project registry, so the only losers are
a project whose registry entry never recorded an origin and a project with no remote at all — which
has nothing on GitHub to poll anyway.

Found while gating: two timeline rows written in the same millisecond came back in either order
(the id's tie-break suffix was random). The suffix now counts up within a millisecond.

**Found and fixed in the Phase 2-4 review pass (pre-dates this plan):** `agentbox git push <box>` on
an `agentbox/*` branch logged the push TWICE — once `actor: human` from the hub's git route, once
`actor: box` from the relay. The branch is a scratch branch, so the relay bypassed the push gate and
never read the host-initiated token, which is also how it knows the host drove the push. Both push
paths (`packages/relay/src/server.ts` and the cloud executor in `host-actions.ts`) now share
`decideHostInitiatedPush`, which validates a claimed token on the bypass path too and keeps the HARD
REJECTION of an invalid one behind `!bypassPushGate` — so no push that succeeds today can start
failing. Covered by `packages/relay/test/push-host-initiated.test.ts` (a real repo + origin over
`/rpc`: a valid token yields no box row, no token and an invalid token each yield exactly one) and
by the smoke below.

- PR sync (`github-prs.ts`): `repoOf(project)` = `gh repo view <owner/repo>` from
  `WorkspaceProject.repoUrl` (non-GitHub → null, cached); iterate `ws.projects`, no folder scan. One
  code path for local and remote.
- Push stat: `pushStatBefore` runs only when `fact.host === hostname()` and the folder exists;
  otherwise a new `boxPushStat(fact, { branch, before? })` seam runs
  `git diff --shortstat <base>..HEAD` inside the box via `provider.exec` (reuse the `boxDiffStat`
  plumbing; base = `merge-base origin/HEAD HEAD` in the box). Cloud boxes on the lease-token push
  path never hit `recordBoxGitPush`: a `git.pushed` notification RPC (`{ branch, before, after }`)
  that `agentbox-ctl git push` sends after a direct push records it. `hostRepoUnavailableReason`
  stays fail-closed.
- `deps.projectBranch` leaves the create path once Phase 2's `fromBranch` default ships.
- Tests: `github-prs` with a fake `ghExec` asserting no `cwd`; box-exec push stat; relay `git.pushed`
  handler + hook.

## Tray must change (that repo is out of scope for code here)

- Read `workspace.hosts[<own hostname>]?.root`, not `root`; hide folder UI when absent.
- Attach `tmux attach` only when `manager.host` is its own hostname; otherwise "runs on <host>" and
  disable attach/resume; drop reliance on `resumeBlockedBy == 'other-host'`.
- On `409 wrong_host` / `manager_unreachable` with `details.host` = own hostname, retry the op
  against `agentbox hub target --json --local`.
- Decode `kind: 'tmux'`, `hostIsHub`, `Workspace.projects[]`; new `POST /workspaces` body (shell
  `agentbox workspace add`, or scan client-side).

## Verification

Unit: the tests listed per phase; `pnpm typecheck`, `pnpm lint`, `pnpm test`; `openapi-coverage`
green after route changes.

Manual, cheapest first (per `hub-testing.md`): `agentbox hub expose` makes this machine the control
box; a second `~/.agentbox` (or a box) plays the PC. Rebuild + restart the hub with
`AGENTBOX_HUB_BIN` and confirm the live bundle with `ps`.

- Phase 1: the "Verification" checklist in `workspaces-tasks-manager-plan.md` passes unchanged on a
  plain local hub; a docker box push still lands a `git.push` row.
- Phase 2 (the matrix is `hub-testing.md` §F): `workspace add` from the "PC" shows on the exposed hub; `tasks add`; a docker create with
  `hub.mode=local --tasks T-1` assigns on the control box and forwards `box.created/ready`; the
  task stays assigned after the PC hub stops. With `--tunnel cloudflare`,
  `agentbox claude --provider e2b --tasks T-2` then `gh pr create` from the box lands `pr.opened`
  on the control box.
- Phase 3: `agentbox manager start --agent claude --attach` from the "PC" (drive harness to type into
  the pane); `manager list` on the exposed hub shows `host`, `status: running` after the first
  heartbeat; `POST …/message` via curl against the exposed hub → 409 + `details.host`; the CLI retry
  types the text; `tasks add` inside the manager's shell stamps `turn` on the control box.
- Phase 4 (`hub-testing.md` §F, F14–F17): e2b box `agentbox-ctl git push` shows `+N −M` on the
  exposed hub's timeline; PR sync marks `pr.ready` with no checkout on the hub.

**Verified locally (2026-09-18, docker, no control box):** in `../agentbox-test-repo` two commits in
a box then `agentbox git push` → `git.push` rows carrying `+7 −0` and `+2 −0`; the same repo's PRs
are labelled by a sync that reports `github: ok` and addresses every `gh` call by repo. The box-measured half and the
`git.pushed` report are covered by the unit suites and by §F, which needs an exposed or deployed
hub.

**Re-verified after the review pass (2026-09-18):** a commit in a box then `agentbox git push
f8smoke` on `agentbox/f8smoke` → exactly ONE `git.push` row, `actor: human`, `additions: 7`
`deletions: 0` (it was two before the token fix). `manager start --agent claude` / `list` / `stop` /
`forget` unchanged; `agentbox create -y` with no `--tasks` exits 0, both with and without an
unreachable control box configured (`hub.mode=local`).

**Real Hetzner control box (required for Phases 2–4, and a full pass at the end).** The exposed-hub
run is the cheap loop; the gate for merging a phase is the same matrix against a real deployed hub,
per `hub-testing.md` §3 and §C/§D:

- Deploy the branch build: `agentbox hub deploy hetzner --ref <branch>` (first time; admin env vars
  inline), then `agentbox hub update --ref <branch>` after each rebuild. Confirm with
  `curl -sf https://<ip>.sslip.io/healthz` and `agentbox hub target` (`mode: remote`).
- PC side: the laptop with `relay.controlPlaneUrl` set, plus the always-on clean test VM
  (`scripts/hub-test-vm.sh`) for the published-CLI shape. Use a non-LFS test repo for hub-created
  boxes.
- Phase 2 gate: `workspace add` + `tasks add` from the laptop land on the VPS
  (`ssh agentbox-hub cat /opt/agentbox/hub-data/workspaces/*/tasks.json`); `agentbox claude
  --provider e2b --tasks T-1` via the hub assigns and forwards `box.created/ready`; the tray (hub
  target = VPS) shows the task count on the box; `gh pr create` in the box → `pr.opened` on the VPS.
- Phase 3 gate: `agentbox manager start` on the laptop registers on the VPS with the laptop's
  `host`; `manager list` shows `running` after the first heartbeat and `stopped` within the window
  after `manager stop`; `POST …/message` against the VPS returns `409` + `details.host`, and the CLI
  retry types into the local tmux pane; the tray attaches locally and shows "runs on <host>" for a
  record registered from the VM.
- Phase 4 gate (the D6 shape): stop the laptop's relay (`agentbox relay stop`), then in the box
  `agentbox-ctl git push` → `git.push` row with `+N −M` on the VPS, and `pr.ready` after the next
  timeline read, with nothing running on the laptop.
- Teardown per §E; check the Hetzner console for leftovers.

**Real control box, §F F1–F17 (2026-09-18).** Run from the laptop against a Hetzner box built from
source at `wip/remote-hub-p2-4`, test repo `agentbox-hubtest`. F1–F13, F15 and F16 pass; F14 and F17
pass on their asserted substance (the two clauses that do not hold are backlog items 14 and 13).
Three things the exposed-hub loop cannot reach, all fixed on the branch: the forwarded-event route
refusing `actor: human` from a **stale container image** whose source checkout was already current;
a local hub, spawned by a create, inheriting the deployed box's `hetzner` profile and API key out of
`control-plane.env` and then rejecting this machine's own token; and a stale local workspace record
shadowing the control box's on the create-row join, so `box.created` went to a workspace id the
control box has never heard of. A `cx23` control box needs swap to build from source (see
`hub-testing.md`).

## Riskiest assumptions

1. Origin-URL identity: forks, ssh vs https spellings and mirrors must normalise to one key; verify
   on real registrations. A project with no remote is host-local only.
2. Heartbeat as manager liveness: a PC that never reports again (hostname change, reinstall) leaves a
   stale running manager until the `lastSeenAt` window expires; `manager forget --force` remains the
   escape hatch. Two PCs with the same hostname would merge mappings.
3. `X-AgentBox-Session-Turn` is client-asserted, like the session header already is; ignore it unless
   the session resolves to a manager of that workspace.
4. The `ManagerRecordStore` refactor touches the most intricate code in the feature (background
   sessions, legacy adoption); delete the legacy paths rather than port them.
5. The queue worker must configure the sink itself; a silent miss loses `box.ready` rows only in
   remote mode, hence the job-log warning.
