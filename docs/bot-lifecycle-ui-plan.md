# Bot lifecycle (backup / restore / clone) in the hub + tray, and hiding git UI for non-git boxes

## Context

Two gaps, both in the two GUI front-ends (hub web UI, macOS tray):

1. **A service bot's whole lifecycle is terminal-only.** `agentbox download --backup` captures a bot
   (workspace + the agent's state dir, identity included) into
   `<project>/.agentbox/bots/<bot>/<stamp>/`; `agentbox <service-agent> --restore <bot>` brings it back
   as a new box; `agentbox clone` spawns a *second* bot from one (same workspace, deliberately fresh
   identity). For a `surface: 'service'` agent (openclaw today) that bundle **is** the bot — its
   gateway token, channel pairings and history — so these are the most important operations on the
   box, and the tray and hub can do none of them. Backup and restore are implemented inline in
   `apps/cli`, which contradicts the repo's own rule (CLAUDE.md → "Do the work behind the hub
   `/api/v1`, not in the CLI"): the logic serves exactly one of four front-ends. **Clone is the
   exception — it is already fully behind the API** (`POST /api/v1/boxes/{id}/clone` →
   `backend.prepareClone` → the ordinary create job); it is simply that no GUI ever calls it.

2. **Git buttons show on boxes with no git repo.** A box created from a plain directory has no
   worktree and no remote, but the hub box page still renders the whole "Git operations" card and the
   tray still shows a Git submenu and a GIT chip row. Every button in them fails. Nothing in the box
   payload says whether the box has a repo at all.

Outcome: the hub box payload gains two derived facts (`hasGit`, `supportsBackup`); the hub gains
backup/restore routes behind `/api/v1`; the hub UI and the tray gain Back-up, Restore **and Clone**
actions, and hide git UI when there is no repo.

### Decisions already taken

- **Backup is offered only for backup-capable agents** — the box's agent declares `stateBackup`
  (openclaw today). Derived from the registry as data; no agent id is ever branched on.
- **`hasGit` is derived host-side on read and served from the hub API** — no `BoxRecord` migration,
  correct for boxes that already exist, and stays right if a project gains a repo later.
- **Restore is project-scoped**: you pick a project, see the bots/backups it already holds, and pick
  one. It creates a **new box** (CLI parity — `--restore` refuses to overwrite a live bot, because two
  gateways holding one identity is the failure the per-box state dir exists to prevent). There is no
  in-place rollback.
- **Clone is box-scoped and needs no new backend work** — the route, the validator (`parseCloneBox`),
  `prepareClone` and `cloneCreateInput` all exist and are exercised by `agentbox clone`. Clone is
  Phase 5/6 UI only. Restore and clone stay clearly distinct in the copy: **restore keeps the
  identity, clone deliberately discards it.**

### Status

| Phase | What | State |
| --- | --- | --- |
| 1 | `hasGit` + `supportsBackup` in the box payload | **done** |
| 2 | Hide git UI when `hasGit === false` (hub + tray) | **done** |
| 3 | Hub API: `POST /boxes/{id}/backup` | **done** |
| 4 | Hub API: `GET /projects/{id}/bots`, `POST /projects/{id}/restore` | **done** |
| 5 | Hub web UI: bot panel (backup + clone), Start-from restore in the create modal | **done** |
| 6 | Tray: backup action, clone in the detail window, restore in the New Box panel | **done** |

### What changed from the plan, and why

- **Restore is a "Start from" row in the create form, in BOTH GUIs**, as planned.
  It first shipped as a footer item; that was wrong. Restore is the same decision
  as a create — which project, which provider, what to call it — with a different
  starting point, so it belongs in that form and not in a flow of its own. Picking
  a backup hides the rows the bundle decides (Branch, Agent, the setup wizard) and
  the bake note, since neither GUI runs a bake phase for a restore. The web's
  project-page card keeps the LISTING but hands off to that one form
  (`initialRestore`) rather than carrying a second restore modal.
- **One select, not two.** A backup is identified by bot AND stamp, so a bot
  picker plus a backup picker made the common case — one bot, one recent backup —
  two decisions where there is none.
- **Clone is in the tray's detail window only, not the box submenu.** It is a
  rare, considered action that opens a naming dialog, and next to Back Up Now in a
  menu the two read as a pair when they are opposites.
- **The hub's backup uses `exportBoxWorkspace`, not the CLI's rsync pull.** Same
  provider-neutral export `clone` already uses, with one new knob
  (`dropAgentScaffolding: false`) so a backup keeps what a clone drops. File
  selection can differ from `agentbox download --backup` at the margins; accepted.
- **Two tray bugs found by the first live backup, both fixed here:** a 10s global
  request timeout against a 79s operation, and `.timedOut` reported as "hub is not
  reachable" while the backup completed server-side.
- **The shared refusals no longer hardcode `--force` / `--into`.** The rule is
  shared between the CLI and the hub; the escape hatch is not, and a web UI told
  to "pass --into <dir>" is being told to use a different program.

### Known gaps

- **Backup is a synchronous POST.** Measured 79s on a hetzner box, most of it the
  workspace export over the provider seam. The clients carry generous timeouts;
  making it a queue job is the proper fix and needs a new job kind (the queue has
  only `create`/`prepare` lanes).
- The tray shows no job log for clone/restore — the new box appears as a
  `creating` row and the menu is the progress indicator.

---

## Phase 1 — `hasGit` + `supportsBackup` in the box payload

**`apps/hub/lib/boxes/types.ts`** — add to `interface Box`, in the "raw host-side fields" block:

```ts
// False when the box's workspace is not a git checkout at all — no worktree,
// no branch, nothing for pull/push/checkout to act on. Clients HIDE their git
// UI on false. Undefined = the source didn't say (hosted/Postgres path, older
// hub, synthetic job row) and must be treated as "show", never as false.
hasGit?: boolean;
// The box's agent declares a state backup (`AgentSyncSpec.stateBackup`), so
// `POST /boxes/{id}/backup` captures an identity and not just a workspace.
supportsBackup?: boolean;
```

**`apps/hub/lib/hub-backend.ts`**

- `mapBox(b, regroup?, originUrl?)` (line 348) gains a fourth parameter `hasGit?: boolean` and sets
  both fields. `supportsBackup` is derived in-place from the spec:
  `findAgentSpec(b.lastAgent ?? b.agents?.[0])?.stateBackup !== undefined` — use `findAgentSpec`
  (returns `undefined`), **not** `resolveAgentSpec` (throws on an unknown id, which a plugin agent
  that was removed would be).
- `getData()` (~line 2100) builds a memo before mapping, one probe per **distinct** `projectRoot`
  (there are far fewer projects than boxes, and it already awaits `hostBranchOf` per project):
  1. `b.gitWorktrees?.length` → `true` (fast path; docker boxes record worktrees)
  2. else `detectGitRepos(projectRoot)` — `@agentbox/sandbox-core`, already imported in this file's
     dependency graph; memoized per `projectRoot` for the call. This is what covers **cloud** boxes,
     which never record `gitWorktrees` (they carry `cloud.workspaceBranch`, which is minted whether or
     not a repo exists — so it is not a usable signal).
  3. no `projectRoot` → leave `undefined`.
- `mapRegistrationToBox(reg)` (line 457): `hasGit: reg.worktrees.length > 0` (`BoxWorktree[]`, doc'd
  "Empty when the box has no git repos"), `supportsBackup` from `reg.agent`.
- `mapJobToBox` (line 692): leave both undefined — synthetic rows show no git or backup UI anyway.

Note the known limitation of `detectGitRepos` (`packages/sandbox-core/src/git-detect.ts`): a
worktree-form `.git` **file** reads as not-a-repo. Do not change that here; it is the same rule the
create path uses, so the payload agrees with what the box actually got.

**`apps/hub/app/(dashboard)/api/v1/lib/openapi.ts`** — add both fields to the Box schema (~line 1963,
beside `gitWorktrees`).

---

## Phase 2 — hide git UI when `hasGit === false`

Gate on `!== false` everywhere, so an older hub, the hosted path, or a synthetic row keeps today's
behavior.

**Hub** — `apps/hub/app/(dashboard)/boxes/[id]/page.tsx:80-81`: wrap the `SectionLabel "Git
operations"` **and** `<GitActions box={box} />` in `box.hasGit !== false`. Nothing else in the web UI
renders git actions (`BoxTable` → `BoxActions` has none).

**Tray** (`../agentbox-tray`) — three files:
- `Sources/AgentBox/Models/Box.swift`: add `let hasGit: Bool?` to the decoded struct (optional, so an
  older hub decodes), plus a derived `var showsGit: Bool { hasGit != false }` next to `isRunning`.
- `Sources/AgentBox/Menu/MenuBuilder.swift:224` (`boxItem`): gate the `Git` submenu item on
  `box.showsGit` inside the existing `if box.isRunning` block. `gitMenu(_:target:)` itself is unchanged.
- `Sources/AgentBox/Menu/BoxDetailWindow.swift:411-423` (`rebuild(for:)`): gate the whole
  `GIT — <branch>` section (label + `justifiedChips(gitChips)`) on `box.showsGit`.

---

## Phase 3 — hub API: backup

**Shared code already exists — reuse it, do not reimplement.**
`packages/sandbox-core/src/sync/concerns/bot-backup.ts` was written for exactly this
("The decisions live in `@agentbox/sandbox-core`'s bot-backup concern so a hub route can reuse them"):
`backupStamp`, `botDir`, `botBackupDir`, `writeBackupManifest`, `linkLatest`, `listBackups`,
`pruneBackups`, `ensureBackupGitignored`, `backupAgentState`, `resolveBotBundle`,
`readBackupManifest`, `restoreAgentState`, `BackupManifest`, `BotBundle`.

The one piece that is CLI-only is target resolution: **move `resolveBackupTarget` +
`prepareBackupDir`** out of `apps/cli/src/commands/_backup.ts` into `bot-backup.ts` and have
`_backup.ts` re-export them, so the CLI and the hub resolve one bundle path.

**Route** — `apps/hub/app/(dashboard)/api/v1/boxes/[id]/backup/route.ts`, `POST`. Follow
`checkpoint/route.ts` verbatim: 409 on a `job:` id, `backendOrNull()`, `readJson` + a new
`parseBoxBackup` in `api/v1/lib/validate.ts`, `failFromAction`. **Synchronous**, like `checkpoint` and
`clone` — a bot's workspace is small, and the queue has only `create`/`prepare` lanes.

Body `{ name?, keep?, agent?, includeNodeModules? }`; returns
`{ ok, bot, stamp, dir, agent?, state, databases?, files, pruned, wroteGitignore }`.

**Backend** — `backupBox(id, opts)` on `HubBackend` (`apps/hub/lib/boxes/backend-types.ts`, in the
checkpoints/clone neighbourhood) + the impl in `hub-backend.ts` next to `prepareClone` (line 3210),
which is the closest existing shape:

1. `resolveBoxProvider(id, hydrate)` → `ensureBoxRunning(rp.provider, rp.box)`.
2. `resolveBackupTarget(rp.box, opts)` → `prepareBackupDir(target)`.
3. Workspace half: **`exportBoxWorkspace`** (`sandbox-core`'s workspace-clone concern) into
   `target.workspaceDir` — the provider-agnostic export `prepareClone` already uses, scoped by
   `agent`. (The CLI's `--backup` uses the `pullToHost`/`pullWorkspaceToHost` rsync pair instead;
   selection can differ slightly at the margins — a known, accepted divergence; do not port the
   rsync path into the hub.)
4. State half: `rp.provider.syncTransport?.(rp.box)` (both `DockerProvider` and `createCloudProvider`
   implement it) → `backupAgentState({ agent, transport, destDir: join(dir,'state') })`. **Best-effort**,
   exactly as `runBackup` does — a failure still yields a usable workspace backup with
   `manifest.state: false`.
5. `writeBackupManifest` → `linkLatest` → `pruneBackups` → `ensureBackupGitignored`.

**Docs**: `apps/web/content/docs/api.mdx` (the routes table) — the `openapi-coverage.test.ts` gate means
the route must also appear in `api/v1/lib/openapi.ts` or the test fails.

---

## Phase 4 — hub API: list bots, and restore

### `GET /api/v1/projects/{id}/bots`

New route beside `projects/[id]/branches/route.ts`; backend `listBots(projectId)`. Resolve the project
by id server-side the way `listBranches` does, then `readdir` `<projectRoot>/.agentbox/bots`, and for
each bot `listBackups` + `readBackupManifest`. Returns

```
{ bots: [{ bot, latest, backups: [{ stamp, agent?, state, boxName, provider }] }] }
```

Read-only, so it can serve from the plain project registry without the mutation backend.

### `POST /api/v1/projects/{id}/restore`

Body `{ bot, stamp?, name?, provider?, into?, force?, persistent? }`. **Mirror the clone route
exactly** (`boxes/[id]/clone/route.ts`): a `prepareRestore` that stages, then the ordinary
`backend.create(...)`, returning the create `jobId` so the CLI, web UI and tray all stream one
progress source.

`prepareRestore(projectId, input)` in `hub-backend.ts`, reusing the guards that already exist in
`apps/cli/src/commands/_restore.ts` — **move the pure ones into `bot-backup.ts`** and have `_restore.ts`
re-export them, so there is one definition of each refusal:

- `resolveBotBundle(projectRoot, bot, stamp)`
- source-box-still-running refusal (`assertSourceBoxNotRunning` — the hub has `listBoxes` + providers,
  so port the body; keep the `--force` escape as `input.force`)
- `existingBoxRefusal` — a box already runs on the destination dir
- destination = `into ?? join(botDir(projectRoot, bot), 'workspace')`; `into` must be **absolute**
  (same rule and same wording as `parseCloneBox`)
- `stageRestoreWorkspace(req, force)`

Then `backend.create({ workspace: stagedDir, agent: bundle.manifest.agent, name, provider,
persistent, restore: { bundleDir, agent } })` — modelled on `cloneCreateInput` in
`apps/hub/lib/boxes/clone-create.ts`. Enqueue in the ungated **foreground** lane, as clone does.

### The state half runs in the queue worker

`QueueJobCreateOpts` (`packages/relay/src/queue.ts`) gains
`restore?: { bundleDir: string; agent: string }`. In `apps/cli/src/commands/_run-queued-job.ts`, the
service-agent branch (`if (!plan.spec || !plan.startsSession)` at lines 434 and 678 — both the docker
and cloud runners) currently logs "runs as a box service; no session to start" and stops. When
`restore` is set it must instead do what `runServiceAgent` does at lines 495-522:

`waitForService` → `stopUnit` → `restoreAgentState` (via `provider.syncTransport`) → `restartService`
→ `waitForService`.

Those helpers are already exported from `apps/cli/src/agents/command/service-action.ts` and the worker
lives in the same app, so import them directly — no new package seam. **Ordering is load-bearing and
is documented in `service-action.ts`:** the service must come up on its own first, because openclaw's
`onboard` is a `run_once: marker` task whose marker lives on the box rootfs; letting it run and *then*
replacing what it wrote is the only sequence that survives later boots. A bundle with
`restoreScope() === 'workspace'` (no state captured) warns rather than fails.

**Docs**: `api.mdx`, `openapi.ts`, plus `sync-and-git.mdx` ("back a bot up" / "bring a bot back") and
`openclaw.mdx` should mention the UI paths now exist.

---

## Phase 5 — hub web UI

**Box detail** (`apps/hub/app/(dashboard)/boxes/[id]/page.tsx`) — a new `<BotPanel box={box} />`
between `<Access>` and the git section. New component
`apps/hub/app/(dashboard)/boxes/components/bot-panel.tsx`, built on the pieces `git-actions.tsx`
already has: a `Card` of `GitOpRow`-shaped rows, `OpButton`s, and the same `useToasts`/`ToastStack`.
Two rows:

- **Backup** — "Back up now", shown only when `box.supportsBackup`. Result toast is `<bot> @ <stamp>`,
  plus a warning line when the manifest came back `state: false` (workspace captured, identity not).
  Show the latest existing stamp from `GET /projects/{projectId}/bots`.
- **Clone** — "Clone…", shown for every non-synthetic box (`agentbox clone` is not bot-only; a TUI
  box's clone is an agentless template copy, and `prepareClone` already picks the right shape from
  `serviceAgentForBox`). Opens a modal for `{ name?, provider?, includeNodeModules?, persistent? }`,
  posts to the existing `POST /api/v1/boxes/{id}/clone`, then renders `JobLogStream` for the returned
  `jobId` — same pattern as the create modal. Copy must say the clone gets a **fresh identity**.
  Surface `prepareClone`'s refusals verbatim rather than as a generic failure; the likely one for a
  bot is `clonePerBoxCarryRefusal` ("`<name>` needs its own secrets before it can be a separate bot —
  create `~/.agentbox/openclaw/<name>.env` (0600) and run this again"), which is actionable and tells
  the user exactly what file to write.

Add `backupBoxAction(id, opts)` and `cloneBoxAction(id, input)` to `apps/hub/lib/boxes/actions.ts`
alongside `gitPushAction` et al.

**Project detail** (`apps/hub/app/(dashboard)/projects/[id]/page.tsx`) — a `<ProjectBots project={proj} />`
card under `projects/[id]/components/` (beside the existing `ProjectSeed`), listing each bot with its
latest stamp and a **Restore…** button opening a modal (stamp `Select`, box name, provider, `force`).
On submit → `POST /projects/{id}/restore` → render `JobLogStream` for the returned `jobId`, exactly as
the create modal does. The card self-hides when the project has no bots.

Per `feedback-hub-web-pure-rest-client`: client-side `fetch` against `/api/v1` only, no server actions.

---

## Phase 6 — tray (`../agentbox-tray`)

Follow the repo's own recipe (its `CLAUDE.md` documents the 9 steps for a new box action):

- `Models/Box.swift` — `let supportsBackup: Bool?` (+ `hasGit` from Phase 2).
- `Source/HubClient.swift` — `backup(id:)`, `clone(id:body:)`, `listBots(projectId:)`,
  `restore(projectId:body:)` on the generic `request(path:method:body:allowRetry:)` / `get(_:as:)` core.
  Clone and restore return a `jobId`; the tray has no job-log viewer, so treat them like `create` does
  today (fire, alert on failure, `refreshNow()` — the new box shows up as a `creating` synthetic row).
- `Source/BoxSource.swift` + `Source/HubAPIBoxSource.swift` — protocol methods and one-line delegates,
  completions on the main queue.
- `Menu/BoxDetailWindow.swift` — new `BoxAction` cases `.backup` and `.clone`; a `BOT` chip row in
  `rebuild(for:)` — "Back Up Now" gated on `supportsBackup`, "Clone…" for every real box.
  **Check the card width**: `justifiedChips` is a fixed 3-column grid sized for "Push to Host", so a
  longer label needs the width constant at line 158 revisited.
- `AppDelegate.swift` — `@objc func backUpBox(_:)` / `cloneBox(_:)` → `dispatch(.backup|.clone, sender)`,
  and the cases in `perform(_:on:)`. Clone prompts with `InputPanel` (name, optional provider) and
  finishes through the `handleGitResult`-style alert + `refreshNow()`; its refusals (missing per-box
  secrets, `persistent` on a capped provider) must reach the alert text unchanged.
- `Menu/MenuBuilder.swift` — "Back Up Now" (gated on `supportsBackup`) and "Clone…" items in
  `boxItem`'s submenu.
- `Menu/CreateBoxPanel.swift` — restore lives here, since restore is project-scoped: when a project is
  selected, fetch `GET /api/v1/projects/{id}/bots`; if non-empty offer a "Restore from backup" source
  with a bot + stamp picker, and submit to `POST /projects/{id}/restore` instead of `POST /boxes`.
  The panel already reads the agent catalog's `surface` for its persistent toggle, so the shape fits.
- Update the tray's `CLAUDE.md` + `README.md` endpoint tables, then `./scripts/make-app.sh` and relaunch.

---

## Files to touch (representative)

| Area | Files |
| --- | --- |
| Payload | `apps/hub/lib/boxes/types.ts`, `apps/hub/lib/hub-backend.ts` (`mapBox`, `mapRegistrationToBox`, `getData`), `apps/hub/app/(dashboard)/api/v1/lib/openapi.ts` |
| Shared backup logic | `packages/sandbox-core/src/sync/concerns/bot-backup.ts` (absorb `resolveBackupTarget`/`prepareBackupDir` + the restore refusals), `apps/cli/src/commands/_backup.ts`, `apps/cli/src/commands/_restore.ts` (become thin re-exports) |
| Routes | `apps/hub/app/(dashboard)/api/v1/boxes/[id]/backup/route.ts`, `.../projects/[id]/bots/route.ts`, `.../projects/[id]/restore/route.ts`, `api/v1/lib/validate.ts`, `api/v1/lib/openapi.ts` |
| Backend | `apps/hub/lib/boxes/backend-types.ts`, `apps/hub/lib/hub-backend.ts`, `apps/hub/lib/boxes/clone-create.ts` (sibling for restore) |
| Worker | `packages/relay/src/queue.ts` (`QueueJobCreateOpts.restore`), `apps/cli/src/commands/_run-queued-job.ts` |
| Hub UI | `apps/hub/app/(dashboard)/boxes/[id]/page.tsx`, `boxes/components/bot-panel.tsx`, `projects/[id]/page.tsx`, `projects/[id]/components/project-bots.tsx`, `apps/hub/lib/boxes/actions.ts` |
| Tray | `../agentbox-tray/Sources/AgentBox/{Models/Box.swift, Source/{HubClient,BoxSource,HubAPIBoxSource}.swift, Menu/{MenuBuilder,BoxDetailWindow,CreateBoxPanel}.swift, AppDelegate.swift}` |
| Docs | `docs/bot-lifecycle-ui-plan.md`, `apps/web/content/docs/{api,sync-and-git,openclaw,hub}.mdx`, `CLAUDE.md` doc map, tray `CLAUDE.md` + `README.md` |

Clone touches **no** route, validator or backend file — it is already there.

---

## Verification

Unit / static:

- `pnpm build && pnpm typecheck && pnpm lint` (tsup does not typecheck — CI runs `tsc` and will fail).
- `pnpm vitest run apps/hub` — `apps/hub/test/openapi-coverage.test.ts` **fails on any route missing
  from `openapi.ts`**, so it is the gate for Phase 3/4.
- `npx prettier --write <changed files>` — never `pnpm format` (it rewrites ~530 unrelated files).

End-to-end — **rebuild and restart the hub between every check**, or it serves the stale staged bundle:

```
pnpm --filter @agentbox/hub build:standalone
AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart
```

1. **`hasGit`** — create a docker box in a non-git dir (`agentbox create -y -n nogit -w /tmp/plain`)
   and one in `examples/`. `curl -s -H "Authorization: Bearer $(cat ~/.agentbox/hub/token)"
   127.0.0.1:8787/api/v1/boxes | jq '.boxes[]|{name,hasGit,supportsBackup}'` — expect
   `false` / `true`. Open both box pages: the git card is absent on the first, present on the second.
   Repeat with a **cloud** box (`--provider e2b`) in a git project — must be `true` despite having no
   `gitWorktrees`.
2. **Backup** — `agentbox openclaw -n botsmoke`, wait for ready, then
   `curl -X POST .../api/v1/boxes/<id>/backup -d '{}'`. Assert on the filesystem, not the exit code:
   `ls <project>/.agentbox/bots/botsmoke/*/state/openclaw.json` exists, `manifest.json` has
   `state: true`, `latest` symlink points at the new stamp, `.gitignore` carries `.agentbox/`.
   Compare the bundle against one produced by `agentbox download --backup` on the same box.
3. **Restore** — `agentbox destroy botsmoke`, then `POST /api/v1/projects/<id>/restore
   {"bot":"botsmoke"}`; stream `GET /jobs/<jobId>/logs` and watch for the state-push step. Then the
   real check per `project-cloud-box-usable-not-just-ready`: open the restored box's Control UI and
   confirm it is the **same gateway identity** (same token, pairings intact), not a fresh onboard.
   Also confirm the running-source refusal: restore while the original box is up → `409`.
4. **Clone** — from the hub box page, clone the openclaw box under a new name. First **without** its
   per-box secret file: the modal must show `clonePerBoxCarryRefusal`'s exact text and create nothing
   (no directory, no project, no box — `prepareClone` refuses before the export for that reason).
   Then write `~/.agentbox/openclaw/<newname>.env` 0600 and retry: the clone lands under
   `<project>/.agentbox/bots/<newname>/workspace`, comes up as a **different** bot (its own token and
   pairings, `SOUL.md`/`IDENTITY.md` re-rendered with the new name), and the source bot is untouched.
   Compare against `agentbox clone` on the same source — same route, so they must agree.
5. **Tray** — `./scripts/make-app.sh && open AgentBox.app`. A non-git box has no Git submenu and no GIT
   chips; an openclaw box has "Back Up Now" and "Clone…" in the submenu and a BOT chip row in the
   detail window; a claude box has "Clone…" only. Restore appears in the New Box panel for a project
   holding backups.

Housekeeping: `apps/cli` tests have **no HOME isolation** — anything touching `~/.agentbox` in a test
hits the real home. Commit promptly (a concurrent process on this repo has wiped uncommitted work),
and re-check the branch before committing.
