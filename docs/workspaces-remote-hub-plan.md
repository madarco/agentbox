# Workspaces, tasks, manager and timeline on a remote control box — plan

Status: **Phases 1-2 done** (2026-09-18), Phase 3 next. One phase per session: branch off origin,
implement, gates + smoke, `/code-review medium`, merge into `feat/workspaces-remote-hub`. Phases 2–4
also gate on a **real Hetzner control box** (see Verification).

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
  fails the create when `--tasks` was asked for.
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

## Phase 3 — Manager on the PC, record on the hub

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

## Phase 4 — Push +/- and PR sync without a checkout

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
- Phase 4: e2b box `agentbox-ctl git push` shows `+N −M` on the exposed hub's timeline; PR sync marks
  `pr.ready` with no checkout on the hub.

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
