# Box sources: carry + repos, several repos per box — plan

Status: **accepted** (2026-11-21; the open questions are settled in §8 Decisions, deferred work in
§9 Backlog). Design only; no product code ships with this doc. Multi-PC Phase 3. Phase 1 below is the single-repo shortcut multi-PC Phase 4 (route box→host requests to the
right PC) needs; multi-repo comes after it.

Related: [`workspaces-remote-hub-plan.md`](./workspaces-remote-hub-plan.md) (repo-URL workspace
records and per-host folder maps), [`plans/box-cp-host-reach-plan.md`](./plans/box-cp-host-reach-plan.md)
(box→host `cp`, custody as the cache), [`create-and-checkpoints.md`](./create-and-checkpoints.md),
[`cloud-create-flow.md`](./cloud-create-flow.md), [`sync-architecture.md`](./sync-architecture.md).

Legend: **[measured]** = checked by running something in this session (the spike is recorded inline);
**[code]** = read from the code at the cited line on `nightly` (`40bac36e`, which includes the
machine id from #418); unmarked = design.

## Decision being designed (owner, 2026-11-21)

Keying a project by its normalised repo URL is an acceptable shortcut, but a box must be able to hold
several repos, so the model is abstracted. A box's **sources** are:

- **carry**: files/folders copied in from a machine or from custody, as `carry:` in `agentbox.yaml`
  does today;
- **repos**: a repo URL plus a checkout path inside the box's `/workspace`.

---

## 1. Today

### 1.1 How a box's content is defined and seeded

There is no declared list of what goes in a box. A create takes **one host folder**
(`workspacePath`, usually the git toplevel, recorded as `projectRoot`) and *discovers* repos in it.

- **Discovery (all host-seeded providers)** [code]: `detectGitRepos(workspace)`
  (`packages/sandbox-core/src/git-detect.ts`) returns the root repo (a `.git` directory at the
  folder) plus every **1st-level** subdirectory that has a `.git` directory (`kind: 'nested'`).
  Worktree-form `.git` files are skipped. So "several repos per box" already half-exists, but only as
  subfolders of one host folder on one machine.
- **docker** [code]: `packages/sandbox-docker/src/create.ts:587-651` loops over the detected repos.
  Each gets a branch picked against the host repo by `pickFreshBranch`: `agentbox/<box>` for the root,
  `agentbox/<box>--<sub>` for a nested repo (`:629-633`); a `--use-branch` reuse applies to the root
  only (`:603`). Each repo's `<hostMainRepo>/.git` is bind-mounted RW at its identical host path
  (`:801-803`), and the worktree is added in-container at `/workspace` or `/workspace/<sub>`. All of
  it is recorded per repo in `BoxRecord.gitWorktrees: GitWorktreeRecord[]`
  (`packages/core/src/box-record.ts:265-295`: `kind`, `hostMainRepo`, `containerPath`,
  `gitWorktreePath`, `branch`, `sanctionedBranch`, `relPathFromWorkspace`). A non-git folder is
  tar-piped into `/workspace` instead.
- **clouds: daytona, hetzner, vercel, e2b, digitalocean, and remote-docker, which reuses the cloud
  scaffold** (`packages/sandbox-remote-docker/src/index.ts:34`) [code]: `seedCloudWorkspace`
  (`packages/sandbox-cloud/src/sync/workspace-seed.ts:96`) does a per-repo shallow
  `git clone --no-checkout file://<hostRepo>`, parks `git stash create` under a temp ref, tars the
  `.git` and the untracked files, uploads, then in the box runs `remote set-url origin <host origin>`,
  `checkout -B <branch>`, stash apply and untracked extract. Three differences from docker:
  - Nested repos are seeded **only when a root repo exists** (`:105-162`). A folder that holds repos
    but is not itself one falls through to the plain tarball (`:172`): no `.git`, no branch.
  - Every repo gets the **same** branch name, `args.branch` (`:144`), not `--<sub>`.
  - **No per-repo record.** The cloud path writes `cloud.workspaceBranch` / `cloud.hostSeeded`
    (`box-record.ts:193-205`) and re-runs `detectGitRepos` against the host folder whenever it needs
    the layout (`packages/sandbox-cloud/src/cloud-provider.ts:1892-1911`, session-start resync).
- **in-box clone (control box)** [code]: `CreateBoxRequest.inBoxClone` is
  `{ authedUrl, originUrl, branch? }`: one repo (`packages/core/src/provider.ts:238`,
  `cloud-provider.ts:962-980`).
- **Hub-created boxes** [code]: `POST /api/v1/boxes` takes exactly one of `projectId` (a folder the
  hub's own machine registered) or `repoUrl` (`apps/hub/app/(dashboard)/api/v1/lib/validate.ts:102`,
  the either/or check at `:109-122`). `repoUrl` goes to the control-plane worker
  (`packages/relay/src/create-worker.ts:194-213`), which clones **one** repo with a leased token into
  `$TMPDIR/agentbox-hub-worker-<jobId>` (`cloneRepoWithLfs`, `:157`), overlays the project's custody
  seed (`apps/hub/lib/hub-worker.ts:184-205`), and runs a normal `provider.create` with that clone as
  the workspace. So the clone into the box is then the shallow host-seed above. The temp clone is
  deleted afterwards; `isHubWorkerClone` (`packages/sandbox-core/src/project-slug.ts`) exists so
  nothing keys on that dead path.
- **carry** [code]: `CarryItem` (`packages/core/src/provider.ts:45`: `src`, `dest`, `mode`, `user`,
  `exclude`, `optional`, replacement rules) is resolved host-side into `ResolvedCarryEntry[]` and
  copied to any box path (not limited to `/workspace`) by `copyCarryPathsToBox` (docker) or
  `uploadCarryPaths` (`packages/sandbox-cloud/src/sync/carry.ts`). The record keeps an audit summary
  with a content hash for the on-start resync (`BoxRecord.carry`, `box-record.ts:397-405`). A hub
  create gets carry from **custody**: the PC packs the approved entries into
  `projects/<slug>/seed/carry.tar.gz` + `carry.json` (`packages/sandbox-cloud/src/custody-seed.ts:89-120`)
  and the worker stages them beside the clone (`hub-worker.ts:202-205, :334-338`).
- **Custody project scope** [code]: `projects/<slug>/…` where the slug is `owner__repo` from
  `projectSlugFromOriginUrl` (`packages/sandbox-core/src/project-slug.ts:57`). Seed material, secrets
  and the `cp` cache all live under it.

### 1.2 How a box is keyed today

| Key | Derived from | Where | Scope |
|---|---|---|---|
| `hashProjectPath(abs)` | sha1 of an absolute path (`packages/config/src/paths.ts:79`) | project registry dirs, project config (`packages/config/src/load.ts:143`), docker checkpoint tags (`packages/sandbox-docker/src/checkpoint.ts:38`), cloud snapshot names (`packages/sandbox-cloud/src/checkpoint.ts:102`), remote-docker checkpoints (`packages/sandbox-remote-docker/src/index.ts:46`), `projectId` on a local create (`apps/cli/src/commands/create.ts:931`), timeline facts (`apps/hub/lib/backend/box-facts.ts:49`) | one folder on one machine |
| `repoProjectKey(url)` = `hashProjectPath(normalizeRepoUrl(url))` | origin URL (`packages/relay/src/workspaces/workspace-store.ts:163`) | workspace project ids, hub project cards for hub-built boxes (`apps/hub/lib/boxes/project-key.ts`) | machine-independent |
| `owner__repo` slug | origin URL (`project-slug.ts:57`) | custody `projects/<slug>/` (seed, secrets, cp cache: `packages/relay/src/cp-cache.ts:42`) | machine-independent, but lossy (below) |
| `BoxRegistration.originUrl` | `git remote get-url origin` of the **first** worktree | relay/hub registration (`packages/relay/src/types.ts:107`), lease target, PR lookups | one repo |
| workspace `hosts[<machine key>].projectRoots[projectId]` | CLI folder scan | workspace record (`packages/relay/src/workspaces/types.ts`, `WorkspaceHost`) | per machine, keyed by `getMachineId()` since #418 (a pre-id entry keeps its hostname key until that machine adopts it) |
| cp cache entry | `projects/<slug>/cp/<sha256("rel:"+path or "abs:"+path)>` + `capturedOn: getMachineLabel()` (`cp-cache.ts:62`, `cp-cache-capture.ts`) | custody | per repo slug; the capturing machine is recorded by hostname label only |

`registrationProjectKey` (`apps/hub/lib/boxes/project-key.ts`) shows the current rule: a box groups
by its **host folder** when it has a real one, else by its repo. So two PCs with the same repo at
different paths produce two project cards, and a checkpoint made on PC A is invisible on PC B (both
checkpoint names hash the path).

### 1.3 Spike: the three URL normalisers disagree [measured]

There are three normalisers: `normalizeRepoUrl` (`packages/relay/src/workspaces/timeline-pr.ts:185`),
`normalizeOriginUrl` (`apps/cli/src/control-plane/hub-adopt.ts:79`), and the custody slug. I ran all
three against the built `@agentbox/relay` / `@agentbox/sandbox-core` dist; the CLI function was
copied verbatim because there is no built CLI dist:

| input | `normalizeRepoUrl` | `normalizeOriginUrl` | custody slug |
|---|---|---|---|
| `git@github.com:Madarco/AgentBox.git` | `github.com/madarco/agentbox` | same | **`Madarco__AgentBox`** |
| `https://github.com/madarco/agentbox` | `github.com/madarco/agentbox` | same | `madarco__agentbox` |
| `ssh://git@github.com:22/madarco/agentbox.git` | `github.com/madarco/agentbox` | **`github.com:22/madarco/agentbox`** | `madarco__agentbox` |
| `git@github-work:madarco/agentbox.git` (ssh alias) | `github-work/madarco/agentbox` | same | `madarco__agentbox` |
| `https://gitlab.com/madarco/agentbox.git` | `gitlab.com/madarco/agentbox` | same | **`madarco__agentbox`** |
| `ssh://git@gitlab.example.com:2222/group/sub/repo.git` | `gitlab.example.com/group/sub/repo` | `…:2222/group/sub/repo` | **`sub__repo`** |
| `/Users/me/src/agentbox` | `/users/me/src/agentbox` | same | `null` |

So, measured: the custody slug is **case-sensitive** (one repo, two custody scopes, depending on how
the PC spelled its origin), **ignores the host** (github and gitlab `madarco/agentbox` share one
scope) and **drops GitLab subgroups**. `normalizeOriginUrl` keeps an explicit port. **No normaliser
expands `~/.ssh/config` aliases**, although the relay already has the expansion for `gh`
(`expandSshHost`, `packages/relay/src/gh.ts:336`, via `ssh -G`). A local-path origin is lowercased,
which is wrong on a case-sensitive filesystem.

### 1.4 Every "one box = one repo = one host folder" assumption

| # | Where | Assumption |
|---|---|---|
| A1 | `BoxRecord.workspacePath` / `projectRoot` (`box-record.ts:328, :443`) | one host folder per box |
| A2 | `detectGitRepos` (`git-detect.ts`) | repos are the folder itself or its 1st-level subdirs; nothing from elsewhere |
| A3 | `seedCloudWorkspace` (`workspace-seed.ts:105-172`) | nested repos only under a root repo; one branch name |
| A4 | cloud resync (`cloud-provider.ts:1895`) | layout re-derived from the host folder, not recorded, so it needs that folder on this machine |
| A5 | `CreateBoxRequest.inBoxClone` (`provider.ts:238`) | one repo URL + one branch |
| A6 | `parseCreateBox` (`validate.ts:109-122`) | one `projectId` or one `repoUrl` |
| A7 | `create-worker.ts:207-213` | one clone, one custody seed |
| A8 | docker `originUrl` from `gitWorktrees[0]` (`sandbox-docker/src/create.ts:848`); cloud from `box.workspacePath` (`cloud-provider.ts:629, :686`) | one origin per box |
| A9 | `BoxRegistration.originUrl` / `projectSlug` (`relay/src/types.ts:107, :126`) | one origin, one custody scope |
| A10 | **[fixed in Phase 1]** `runGitRpc` cloud push (`packages/relay/src/host-actions.ts:1326-1400`) | bundles from the requested `containerPath` (nested allowed) but fetches into / pushes from **`lookup.workspacePath`**, the root host folder, with the single registered origin. **[code] A push from a nested repo in a cloud box therefore targets the root repo**: a latent bug today, independent of this plan. Docker is correct: it uses `resolveWorktree` (`packages/relay/src/worktree.ts:11`), which picks the worktree by longest path prefix. |
| A11 | `resolveHostGitRepo` (`host-actions.ts:1259`) | the checkout-less fallback uses the single origin |
| A12 | `POST /api/v1/boxes/{id}/git/{op}` (`apps/hub/app/(dashboard)/api/v1/boxes/[id]/git/[op]/route.ts`) and `agentbox git` (`apps/cli/src/commands/git.ts:166-270`) | no repo selector; `git pr create` injects the **root** branch (`git.ts:333`) |
| A13 | Box payload `repo`, `branch`, `pr`, `projectId`, `projectRoot` (`apps/hub/lib/boxes/types.ts:54-122`); `branch` = `gitWorktrees[0]` (`apps/hub/lib/hub-backend.ts:399`) | one repo/branch/PR per box |
| A14 | timeline facts: `boxFactOf` reads `gitWorktrees[0]` (`box-facts.ts:34`); `timeline-hooks.ts:306` the same | one branch for PR matching |
| A15 | `registrationProjectKey` (`project-key.ts`) uses `worktrees[0].hostMainRepo` | one project card per box |
| A16 | checkpoint names hash `projectRoot` (docker `checkpoint.ts:38`, cloud `checkpoint.ts:102`, remote-docker `index.ts:46`) | a checkpoint belongs to a folder on one PC |
| A17 | cp: `boxWorkspacePath(boxId)` (`host-actions.ts:891`) resolves relative paths against the one folder; cache prefix is one slug (`cp-cache.ts:42`) | one host folder answers every relative path |
| A18 | custody seed `projects/<slug>/seed/` (`custody-seed.ts`) | carry + untracked + env belong to one repo |
| A19 | `hasGit` = "any worktree" (`hub-backend.ts:577`, `:528` probe of the project root) | git-ness of a box is one fact |
| A20 | `capturedOn: getMachineLabel()` (`cp-cache-capture.ts`) | the cp cache names its source machine by hostname only. Multi-PC Phase 1a (#418) moved manager records, workspace `hosts` and timeline rows to the machine id; this one is left for Phase 1 here |

---

## 2. The model

### 2.1 Data shape

One record per box, shared by `BoxRecord`, `BoxRegistration` and the API:

```ts
// packages/core/src/box-sources.ts (new, pure; shipped to the relay and the hub)
export interface BoxSources {
  version: 1;
  repos: RepoSource[];   // [] for a repo-less box (service agents, plain folders)
  carry: CarrySource[];
}

export interface RepoSource {
  /** Stable within the box: the checkout path, '' for the root. The selector `--repo` takes. */
  path: string;                 // relative to /workspace; '' | 'api' | 'libs/core'
  /** Normalised identity (§3). Absent only for a repo with no remote. */
  repoKey?: string;             // 'github.com/acme/api'
  /** The origin as the box's `git remote` spells it: push target, lease target. */
  url?: string;
  /** Per-box scratch branch, immutable identity (today's GitWorktreeRecord.branch). */
  branch: string;               // 'agentbox/<box>'
  /** Last branch the host sanctioned (today's sanctionedBranch). */
  sanctionedBranch?: string;
  /** Ref the branch was forked from, when one was asked for. */
  base?: string;
  /** Where the bytes came from at create time. */
  seededFrom:
    | { kind: 'machine'; machineId: string; label: string; folder: string }   // PC-driven create
    | { kind: 'clone' }                                          // hub worker / in-box clone
    | { kind: 'checkpoint'; ref: string };
  /** Docker only: the per-box git worktree registration path. */
  gitWorktreePath?: string;
}

export interface CarrySource {
  src: string;                  // as written in agentbox.yaml (`~/x`, `./y`)
  dest: string;                 // box path
  from:
    | { kind: 'machine'; machineId: string; label: string; absSrc: string }
    | { kind: 'custody'; key: string };
  bytes: number;
  hash?: string;                // content hash, for the on-start resync (today's carry.entries[].hash)
}
```

`RepoSource` replaces `GitWorktreeRecord` field for field (`kind` is derived: `path === ''`), adds
`repoKey`/`url`/`seededFrom`, and drops `hostMainRepo`, a machine-local fact that moves to the
checkouts registry (§4). `CarrySource` is today's `BoxRecord.carry.entries` plus where each entry came
from.

The **primary repo** is `repos.find(r => r.path === '')` or, when there is no root, `repos[0]`. It is
what every single-repo surface (payload `repo`/`branch`/`pr`, project card, custody scope) keeps
showing, so nothing that reads one repo breaks.

### 2.2 Where it is declared

From most explicit to the default:

1. **API**: `POST /api/v1/boxes` gains `sources: { repos: [{ url, path?, base? }] }` as a third
   option next to `projectId` / `repoUrl`. `repoUrl` stays, as sugar for one repo at `path: ''`. The
   either/or check becomes "exactly one of `projectId`, `repoUrl`, `sources`". `sources` may have
   `repos: []` with a non-empty `carry` (a repo-less, carry-only box, Decision 7 and §3.3); a
   `sources` with neither repos nor carry is a `400`.
2. **CLI**: `agentbox create --repo <url-or-folder>[:<path>][@<base>]`, repeatable. A folder
   argument is resolved on the PC (its origin plus this machine's folder); a URL means "clone it",
   i.e. a hub/clone create. Consistent with the config-key rule, a repeated flag rather than an env
   var.
3. **`agentbox.yaml`**: a new top-level `repos:` block, a sibling of `carry:`, read host-side only
   (added to the host-only key list in `packages/ctl/src/config.ts:666-690` the way `carry` is):
   ```yaml
   repos:
     - url: git@github.com:acme/api.git
       path: api
     - url: git@github.com:acme/web.git
       path: web
       base: develop
   ```
   The yaml that declares it is the **primary** repo's (the folder the create ran in). Its own repo is
   implicitly `path: ''` unless it lists itself under another path.
4. **Default, with nothing declared**: today's discovery (root + 1st-level nested), translated into
   `RepoSource[]`. This is the migration path for every existing project, and the only path in Phase 1.

A **workspace record** does not declare box sources. It stays the planning unit (several projects, a
task list). Phase 6 may let `--tasks` spanning two projects of one workspace prefill `--repo` for
both, but that is a convenience over (2).

### 2.3 Where it is stored

- PC: `BoxRecord.sources` in `~/.agentbox/state.json`. `gitWorktrees` and `carry` stay readable
  (§6) but new writes go to `sources`.
- Relay / hub: `BoxRegistration.sources`, the copy a control box holds for a box whose PC is off.
  `originUrl`/`projectSlug` remain as the primary repo's values for older readers.
- Hub: a new **checkouts registry** (§4), the only place a machine-local folder lives for a box that
  is not on this machine.

### 2.4 `/api/v1` shape (tray contract)

Additive only. The macOS tray decodes `repo`, `branch`, `pr`, `projectRoot`, `hasGit`, `gitWorktrees`
by name, so all of them keep their meaning, now defined as "the primary repo's":

```jsonc
// GET /api/v1/boxes → Box
{
  "repo": "acme/api", "branch": "agentbox/fix-1", "pr": { … },  // primary, unchanged
  "hasGit": true,                                                // repos.length > 0
  "sources": {                                                   // NEW, optional
    "repos": [
      { "path": "", "repoKey": "github.com/acme/api", "branch": "agentbox/fix-1", "pr": { … } },
      { "path": "web", "repoKey": "github.com/acme/web", "branch": "agentbox/fix-1" }
    ],
    "carry": [ { "src": "~/.npmrc", "dest": "~/.npmrc", "bytes": 120 } ]
  }
}
```

- `POST /boxes/{id}/git/{op}`: body gains optional `repo` (a `path`). Absent means primary. With
  several repos and no root, absent returns `400 ambiguous_repo` listing the paths.
- `GET /api/v1/checkouts?repoKey=…` and `PUT /api/v1/checkouts` (§4).
- **Tray work** (in `../agentbox-tray`, per its CLAUDE.md): decode `sources` as optional, show one
  PR badge per repo, and send `repo` on git actions from a per-repo submenu. The tray keeps working
  unchanged until then, because every existing field keeps its meaning.

---

## 3. Identity

### 3.1 Repo key: one function, run where the alias is known

`repoKey(url, { expandHost })` in `packages/relay/src/workspaces/repo-key.ts` (new) replaces the three
normalisers (§1.3). `normalizeRepoUrl` becomes its implementation and `normalizeOriginUrl` is deleted.

Rules:

1. Trim; strip the scheme, any `user[:pass]@`, a trailing `/`, and a trailing `.git`.
2. scp form `host:path` → `host/path`.
3. **Drop the port.** The same repo over ssh:22 and https:443 is one repo. Self-hosted forges on
   non-standard ssh ports are the case to watch (Decision 4).
4. **Expand `~/.ssh/config` host aliases via `ssh -G`** (reuse `expandSshHost`) **for non-http(s)
   URLs only**, the same `aliasable` rule `packages/relay/src/git-pat.ts:107` already applies. This
   has to happen **on the machine whose `~/.ssh/config` it is**: the CLI computes the key and sends
   it, and the hub never re-derives a key from an aliased URL. A key the hub cannot verify is
   accepted as sent, and the raw `url` is kept beside it.
5. Lowercase **host and path**. GitHub treats owner/repo case-insensitively; GitLab namespaces do
   too in practice. Keep the full path, so subgroups survive (`gitlab.example.com/group/sub/repo`).
6. A **local-path** remote (`/x/y`, `file:///x/y`) has no portable identity: key it
   `local:<machineId>:<path>`, case preserved. It only ever matches on that machine.
7. No remote at all: no `repoKey`; the repo is identified by `(boxId, path)` only.

**Custody slug** becomes a function of the key, not a second parser: `projectSlug = <host>__<path
with '/' → '__'>`, sanitised to custody's `[A-Za-z0-9._-]` charset and run through a sha256 prefix
when it would exceed a segment. Readers try the new slug first and the old `owner__repo` second
(§6); writers write the new one only.

### 3.2 What identifies a box with several repos

The **box id** stays the identity; sources are attributes. A box's **project keys** are the set of
its repos' `repoKey`s, and its **primary key** is the primary repo's. Concretely:

- Project card / `Box.projectId`: `repoProjectKey(primaryKey)`. A box with two repos shows under
  its primary project, and a project page lists boxes where it appears in *any* `sources.repos`.
- Workspace join (`workspaceForBox`): any of the box's repo keys matching a workspace project joins.
  Folder-first matching stays for boxes on this machine.
- Custody scope for **carry and secrets**: the primary repo's slug (where `agentbox.yaml` lives). The
  per-repo seed (untracked/env) lives under each repo's own slug.

### 3.3 Repo-less boxes

`repos: []`. That covers service agents (openclaw), a plain non-git folder, and a box made only of
carry. `hasGit` becomes exactly `sources.repos.length > 0`, still derived on read, so it stays right
for old boxes. Such a box has no project key. It groups under its folder on its own machine (today's
`hashProjectPath(projectRoot)`) or, from another machine, under "no project". Its carry still
resolves through `CarrySource.from`. Phase 4's lookup answers "the origin machine or the cache",
never "any machine with the project".

**The hub accepts a repo-less, carry-only box** (Decision 7). Today the "one of
`projectId`/`repoUrl`" check (`validate.ts:109-122`) refuses one, although service agents such as
openclaw are already repo-less boxes. With `sources: { repos: [], carry: [...] }`:

- **Carry custody scope.** A repo-less box has no project slug, so its carry cannot live under
  `projects/<slug>/seed/`. The CLI uploads the approved entries before posting the create to a
  box-scoped prefix, `boxes/<key>/carry/` (`carry.tar.gz` + `carry.json`, the same pair
  `custody-seed.ts` writes per project). `<key>` is a client-minted id sent in the create body and
  stamped on the registration. That is the same `boxes/<id>/…` fallback the cp cache already uses for
  a box with no remote (`cp-cache.ts:44`). Each `CarrySource` records `from: { kind: 'custody',
  key }`, so a later start or resync reads the same entry with the PC off.
- **Workspace.** The worker skips the clone: the job dir is an empty folder with the staged carry
  beside it (today's `<dest>.carry` sibling, `hub-worker.ts:202-205`), and `provider.create` seeds
  it as a plain, non-git workspace (the existing tarball path). The result is an empty `/workspace`,
  `hasGit: false`, no branch.
- **`agentbox.yaml`.** It comes from carry, like any file: an entry with
  `dest: /workspace/agentbox.yaml` is what ctl reads on boot, so a carry-only box can still declare
  services and tasks. With no such entry the box runs no units, and its agent is what it is for.
- **Payload and UI.** `projectId` is absent and the box groups under "no project". `hasGit: false`
  already hides the git UI in the web UI and the tray (`docs/bot-lifecycle-ui-plan.md` Phase 2).
- **Service agents.** Their create routing on a remote hub is a separate, known gap
  (`docs/workspaces-remote-hub-backlog.md`). This path is what they would use, but moving them onto
  it is out of scope here.

---

## 4. Per-machine mapping: the checkouts registry

"Machine M has repo R at folder F" becomes a hub-level fact, independent of workspaces, keyed on the
machine id that multi-PC Phase 1a landed in #418 [code]: `getMachineId()` in
`packages/config/src/machine-id.ts`, a random UUID minted once into `~/.agentbox/machine-id`. The
same module provides `tryGetMachineId()` (undefined on an unwritable `$HOME`), `getMachineLabel()`
(the hostname, display only), `thisMachine(): MachineRef` (`{ id?, label }`), `sameMachine(rec, me)`
(the id decides when both sides have one; the hostname is only the legacy fallback) and
`machineKeyFor`/`machineKeyIn` for `hosts`-style maps. The checkouts registry uses these as they are
and adds no identity of its own.

```ts
// packages/relay/src/checkouts/types.ts (new); store file ~/.agentbox/hub/checkouts.json
export interface CheckoutRecord {
  repoKey: string;
  machineId: string;     // getMachineId() of the reporter; required (below)
  folder: string;        // absolute, realpath'd, on that machine
  label: string;         // getMachineLabel() at last report, display only
  seenAt: string;        // last report
  head?: string;         // branch checked out, informational
}
```

- **Writers (PC → hub)**: the CLI posts `PUT /api/v1/checkouts` with `{ machineId, label, entries:
  [{ repoKey, folder }] }` whenever it already knows a folder: a create (each repo source with
  `seededFrom.machine`), `workspace add`/rescan (the scan in `workspace.ts` already reads every
  project's origin), and project registration (`registerProject`). It is idempotent, and the last
  report per `(repoKey, machineId, folder)` wins. A folder that no longer exists is removed by the
  next report from that machine. It is never inferred on the hub, which cannot stat a PC. **A report
  with no machine id is refused** (`tryGetMachineId()` returned undefined, or the client predates
  #418). Unlike a workspace `hosts` entry there is no hostname-keyed legacy data to adopt, and a
  hostname alone vouches for nothing, which is the rule `machineKeyIn` already follows.
- **Workspaces** (Decision 5): `WorkspaceRecord.hosts[*].projectRoots` stays as it is, already keyed
  by machine id since #418, and the two stores live **side by side**. The workspace scan is simply
  one more writer of checkouts. Folding the workspace host maps into the registry is backlog item B1
  (§9).
- **Reader for multi-PC Phase 4**, pure, in `packages/relay/src/checkouts/resolve.ts` (new):

  ```ts
  /** Which machines can answer a box→host request for `boxPath`, in the order to try. */
  export function hostCandidatesFor(
    box: { sources: BoxSources; originMachineId?: string },
    boxPath: string,                 // as the box asked: '/workspace/web/data.csv' or 'data.csv'
    checkouts: CheckoutRecord[],
    online: (machineId: string) => boolean,
  ): {
    repo?: RepoSource;               // the repo whose checkout path prefixes boxPath (longest wins)
    relPath: string;                 // path relative to that repo's root
    candidates: Array<{ machineId: string; folder: string; reason: 'origin' | 'has-repo' }>;
    cacheKey: { prefix: string; key: string };   // custody fallback, always present
  };
  ```

  Order: (1) the machine the repo was seeded from (`seededFrom.machineId`), if online; (2) any other
  online machine with a checkout of `repo.repoKey`, newest `seenAt` first; (3) the custody cache. A
  path outside every repo (or a repo with no `repoKey`) gets only (1) then (3), so a machine with a
  different checkout never serves a file. Relative paths resolve against `/workspace`, i.e. the root
  repo, matching today's `cp fromHost ./x`. With no root repo, a relative path that names no repo is
  rejected with the list of checkout paths.

- **cp cache key per repo**: `projects/<slug(repoKey)>/cp/<sha256("rel:" + relPath)>`, so two
  machines with the repo at different folders read and write the same entry. Absolute and
  outside-repo paths stay box-scoped (`boxes/<id>/cp/…`, today's no-slug fallback, `cp-cache.ts:44`).
  The entry's metadata gains `capturedOnMachineId` (`getMachineId()`) beside today's
  `capturedOn` label. #418 left it out because nothing read it then; `hostCandidatesFor` does, to
  tell a cache entry from the origin machine apart from one written by another machine with the repo.

---

## 5. Multi-repo mechanics per provider

| Concern | v1 behaviour |
|---|---|
| **Branch naming** | `agentbox/<box>` in **every** repo of a new box (what cloud already does). Same name across repos makes a multi-repo change one branch name to land and review. Docker's `--<sub>` suffix (`create.ts:632`) is kept on existing records (the branch is recorded) and dropped for new boxes. `pickFreshBranch` bumps per repo, so `-2` may differ between repos; the record holds each one. (Decision 2.) |
| **docker** | Already loops N repos with a bind-mounted `.git` each (§1.1). Generalisation: each `RepoSource` resolves its **own** `hostMainRepo` through this machine's checkouts (or the folder given to `--repo`) instead of all being subdirs of one folder. Container path is `/workspace/<path>`. Mount stays `<hostMainRepo>/.git:<hostMainRepo>/.git`, so two repos from unrelated folders mount side by side unchanged. **A repo with no checkout on this machine is refused** for docker in v1 ("docker boxes need a local checkout of `<repoKey>`; clone it or use a cloud provider"). A managed mirror under `~/.agentbox/repos/` is backlog item B3 (Decision 3). |
| **clouds + remote-docker** | `seedCloudWorkspace` takes `RepoSource[]` (each with its host folder) instead of discovering, which removes A3: no-root layouts get git too. The per-repo clone/stash/untracked/extract is unchanged. Record the sources (removes A4: resync reads `sources`, not `detectGitRepos`, so it also works from a machine with a different checkout layout). |
| **hub / in-box clone** | `inBoxClone` and `CreateJobRequest` carry `repos: [{ url, path, base? }]`; the worker clones each into `<job>/<path>` (each with its own leased token: a GitHub App installation covers several repos of one owner, other owners need separate leases) and overlays each repo's custody seed. LFS handling per repo, unchanged. |
| **push / fetch through the relay** | Everything resolves the repo by `containerPath` with `resolveWorktree`'s longest-prefix rule, generalised to `sources.repos`. Cloud `runGitRpc` must use that repo's host folder (from checkouts on this machine) or its own `url` for the checkout-less path, which also fixes A10 for today's nested repos. The push gate's sanctioned-branch rule is per repo. |
| **checkpoints / restore** | Docker: the image carries all of `/workspace`. Restore already regenerates one worktree per recorded repo (`create.ts:559-584`), and keeps doing so from `sources`. Cloud: the overlay re-seed runs per repo. **Checkpoint names stay keyed by `hashProjectPath(projectRoot)` in v1** (A16): moving them to the primary repo key is what makes a checkpoint usable from another PC, and that is a separate change: backlog item B2, not multi-PC Stage 1 (Decision 6). |
| **`agentbox git pull/push/checkout/branch`** | `--repo <path>` on every subcommand, plus `repo` in the API body. Default is the primary repo. No root and several repos → refuse, listing paths. `git pr create` injects the selected repo's branch (A12). `--all` for `push`/`pull` is a later nicety, not v1. |
| **in-box `agentbox-ctl git`** | Already sends `params.path = cwd`, so it already picks the right repo once the relay resolves by prefix. No ctl change beyond what the relay does. |
| **timeline / PR sync** | `TimelineBoxFact.branches` becomes per repo (`{ repoKey, branches }[]`). `github-prs.ts` matches a PR to a box by `(repoKey, head branch)`, which is already how it lists PRs per project. `Box.pr` stays the primary repo's PR. `sources.repos[].pr` carries the rest. Lanes stay `box:<id>`, so one lane per box, with PR rows per repo. |
| **`cp` paths** | §4: relative = from `/workspace`; the repo is chosen by path prefix; the cache key is per repo. |
| **carry** | Unchanged mechanics. The record gains `from`, so the on-start resync re-copies only entries whose source machine is this one. From another machine it skips them and logs it, instead of copying that machine's different `~/.npmrc`. |

**Multi-repo in v1**: docker (local checkouts only), hetzner, daytona, vercel, e2b, digitalocean,
remote-docker, and hub-created boxes; `git`, `cp`, timeline/PR, payload.

**Single-repo in v1, with a clear error on a multi-repo box**: `--use-branch` (root only, as today,
error if the box has no root), `agentbox fork`, teleport between PCs as a *create* (re-attach is
unaffected), service-agent backup/restore/clone (repo-less anyway), checkpoint-as-default across
machines, and `download.workspace`, which downloads all of `/workspace` and is fine but not
per-repo.

---

## 6. Migration (no user step)

- **Existing `BoxRecord`s** have no `sources`. `readState` derives them on read: docker from
  `gitWorktrees` (one `RepoSource` per worktree, `seededFrom: machine(<this machine>, hostMainRepo)`,
  `repoKey` from that folder's origin, cached); cloud from `cloud.workspaceBranch` plus one
  `detectGitRepos` of `workspacePath` when it exists on this machine. Otherwise it falls back to a
  single root repo from the registration's `originUrl`. Writing back happens on the next locked write,
  the same pattern as the v1→v2 workspace upgrade.
- **Existing registrations** (control box store): derived on read from `worktrees` + `originUrl`.
  Registrations from new code send `sources`; old CLIs keep sending `originUrl`, and the hub accepts
  both.
- **Payload**: additive (§2.4). Old tray builds ignore `sources`.
- **Custody**: dual-read slug (new key-derived, then legacy `owner__repo`). A successful legacy hit is
  copied forward under the new slug on the next write (seed push, cp capture). Nothing is deleted.
- **Configs**: no `repos:` means discovery, identical to today. An older CLI ignores `repos:`
  (the host resolver only reads keys it knows), and an older in-box ctl parses the file with a
  non-fatal unknown-key warning (`packages/ctl/src/config.ts:680`) [code]. Adding `repos` to
  `TOP_LEVEL_KEYS` silences that warning for new boxes.
- **Workspace `hosts` / hostname keys**: already handled by #418 (an entry keyed by hostname is
  adopted under the machine id the next time that machine reads or rescans it, and only when its
  folder exists there). Nothing in this plan touches it. The checkouts registry starts empty and fills from the first
  report. Until a machine reports, Phase 4 treats it as "origin only, then cache", which is today's
  behaviour.

---

## 7. Phases

One session each: branch off origin, implement, gates (`pnpm typecheck`, `pnpm test`, `pnpm lint`),
smoke, `/code-review medium`, update `apps/web/content/docs/` in the same change.

### Phase 1: repo key + checkouts registry (single repo; unblocks multi-PC Phase 4)

**Status: done** (PR #424, branch `feat/repo-key-checkouts`). What landed, and where it differs
from the design above:

- **Where `repoKey` lives.** In `@agentbox/config` (`packages/config/src/repo-key.ts`), not
  `packages/relay/src/workspaces/repo-key.ts`: sandbox-cloud and the hub's seed route need it too,
  and that route can't import an execa-carrying barrel. `repoKey()` is pure with an injected
  `expandHost`; `repoKeyAtEdge()` in `@agentbox/sandbox-core` supplies `ssh -G` (60 s cache, `--`
  before the destination) and the machine id. `normalizeOriginUrl` is deleted, and the hub's inlined
  slug mirror (`seed-slug.ts`) is gone. A query or fragment is dropped; a bracketed IPv6 scp host
  parses.
- **ssh expansion.** A non-http(s) host is replaced by the hostname `ssh -G` resolves it to whenever
  that differs, dotted aliases included (`github.com-work`, `work.github.com`). `repoKey` maps the
  forges' ssh-over-443 endpoints back (`ssh.github.com`, `altssh.gitlab.com`,
  `altssh.bitbucket.org`), so the common `Host github.com / HostName ssh.github.com` config keys
  like https.
- **Workspace project ids did not move.** They hash `repoMatchKey`, which is the old
  `normalizeRepoUrl` kept byte for byte (`workspace-store.ts`), so existing workspace records, the
  tasks filed under their project ids and workspace joins are untouched for every remote shape,
  including the ones `repoKey` spells differently (`host:/abs/path`, percent-encoding, `.GIT`, a
  local path). Moving workspace ids onto `repoKey` goes with B1.
- **Custody slug** is `custodySlugForRepoKey` (`github.com__owner__repo`). It gets a sha256 suffix
  when it would exceed 80 chars or would not decode unambiguously (a segment sanitised, or holding
  `__` or an edge `_`, so `a/b/c` and `a/b__c` never share a scope). Writers on the PC use
  `projectSlugAtEdge` (alias-expanded). A hub-routed create carries the PC's `repoKey`
  (`POST /boxes` → `CreateJobRequest.repoKey` → `CreateBoxRequest.repoKey`), because the control box
  cannot expand the PC's aliases: the worker reads the seed and the box registers under that key.
  Both seed readers go through `applyProjectSeedForRepo` (requester's key, URL key, then the legacy
  `owner__repo` slug only when its manifest names the same repo path); seed status and the cp-cache
  lookup try `custodySlugCandidates`. A legacy entry is not copied forward on read. Upgrade order:
  control box first (a new CLI writes slugs an old control box does not read).
- **Registration only, not `BoxRecord`.** `repoKey`, `originMachineId` and `originMachineLabel` are
  stamped in `registerBoxWithRelay` and `registerBoxWithPlane` (`registrationOrigin()`), and the
  relay keeps the first origin machine across re-registers (`mergeRegistrationOrigin`): a start from
  PC B does not claim a box PC A seeded. A box built from either worker's per-job clone
  (`isEphemeralWorkerClone`: `agentbox-hub-worker-*`, `agentbox-cp-worker-*`) gets no origin
  machine. The `BoxRecord` stamp moves to Phase 2 with `sources`, which is where it is read.
- **Checkouts writers** are all on the reporting machine, through
  `apps/cli/src/lib/checkouts-report.ts` (folders realpath'd by `checkoutEntriesFor`, its own
  vanished rows sent as `removed`): `agentbox create` and every agent command, `workspace add` /
  `rescan`, and a manager session that registers a workspace. The hub records only folders on its
  own disk (a project registered through `POST /projects`). The store moves a corrupt file aside
  before writing, refuses to overwrite an unreadable one, and drops rows not reported for 90 days.
  Any caller holding the hub key can report under any machine id: fine for a single-tenant hub,
  and the thing to tighten for multi-user. No CLI command lists checkouts yet;
  `GET /api/v1/checkouts` is the surface.
- **`hostCandidatesFor`** takes a `CandidateBox` (`{ boxId, originMachineId?, repos, cachePrefixes? }`)
  until Phase 2's `BoxSources`; `candidateBoxFromRegistration` builds one. It returns
  `{ ok: false, error }` for a relative path with no repo to resolve it against. Its cache fallback
  is keyed exactly as today's capture keys it (the request as spelled: `rel:x`, `abs:/workspace/x`,
  `abs:<host path>`) under the root repo's prefixes, legacy slugs included (`readPrefixes`), so
  existing entries hit; only a nested repo gets its own slug and a repo-relative key. Host-absolute
  paths are served by the origin only.
- **A10 is fixed**: `runGitRpc` resolves the in-box repo's toplevel and accepts a nested repo only
  when it is one level under `/workspace` and the host has it as a seeded repo (`detectGitRepos` of
  the box's host folder: a real `.git` directory), then fetches into / pushes from that subfolder
  (`resolveCloudGitTarget`). A box-made `git init`, a deeper or submodule repo, a nested repo with
  no host checkout, and a repo outside `/workspace` are all refused.

Builds on multi-PC Phase 1a, landed in #418 (`getMachineId()` / `thisMachine()` in
`@agentbox/config`).

- `repoKey()` (§3.1) with ssh-alias expansion at the CLI edge; delete `normalizeOriginUrl`; route
  `repoProjectKey`, `workspaceProjectId` and `hub-adopt` matching through it.
- Custody slug from the key, with dual read (§6).
- Stamp `originMachineId` (`getMachineId()`) plus its label and the primary `repoKey` on the
  registration and the `BoxRecord` at create (all providers: they share `registerBoxWithRelay`).
- `capturedOnMachineId` on cp cache entries (§4).
- Checkouts store + `PUT/GET /api/v1/checkouts` + `openapi.ts`, with the CLI reporting on create,
  `workspace add` and project register.
- `hostCandidatesFor()` pure + unit tests (origin online, origin offline + other machine with the
  repo, no checkout anywhere → cache, path outside the repo → origin only, repo-less box).
- cp cache key per repo (`rel:` relative to the repo root).

**Verify**: unit tests; `hub expose` on this box as the hub, with PC A = this box and PC B = the
Linux test VM (`scripts/hub-test-vm.sh`) holding the same repo at a **different** path and spelled
with an ssh alias. `GET /checkouts` shows both under one key. Then on a **real Hetzner control box**:
a hetzner box's `cp fromHost ./x` with PC A off is answered by PC B once Phase 4 wires the lookup
(Phase 1 only proves the lookup's answer, via a debug route or unit test).

### Phase 2: `BoxSources` recorded and derived (read side, no new behaviour)

- `packages/core/src/box-sources.ts`; `BoxRecord.sources`, `BoxRegistration.sources`; derivation for
  old records (§6); cloud creates start **recording** repos.
- Payload `sources` (additive); `hasGit` from it.
- Fix A10: cloud `runGitRpc` resolves the repo by `containerPath` and pushes from that repo's folder.

**Verify**: docker box and **hetzner box**, both from a folder with a root repo + one nested repo.
`GET /boxes` shows two sources. Commit in the nested repo from inside the box, `agentbox-ctl git
push` from that subdir, and confirm (with `git log` on the host, not the exit code) that the branch
lands in the **nested** repo for both providers.

### Phase 3: declare repos (`repos:`, `--repo`, API `sources`), docker multi-repo

- yaml `repos:` (host-only key), `--repo` flag, `parseCreateBox` third option; resolve each repo to a
  folder on this machine via checkouts / the flag.
- Docker: per-repo `hostMainRepo` from distinct folders; refuse a repo with no local checkout.
- New boxes get `agentbox/<box>` in every repo.

**Verify**: a docker box from `examples/<x>` + `--repo ../agentbox-test-repo:test`. Both trees are
in `/workspace`, commits and pushes from each land in the right repo, and `destroy` removes both
worktree registrations (`git worktree list` in each host repo).

### Phase 4: cloud + remote-docker multi-repo seeding

- `seedCloudWorkspace(RepoSource[])`, including no-root layouts; resync from `sources`; checkpoint
  overlay per repo.

**Verify**: **hetzner box** with two unrelated repos (one no-root layout); stop/start (resync);
checkpoint and create from it (overlay). Then one e2b or vercel box for the SDK-transport path, and
one remote-docker box against the Linux test VM's engine.

### Phase 5: hub-created multi-repo

- `CreateJobRequest.repos`, a clone per repo with its own lease, a custody seed per repo, carry from
  the primary repo's scope.

**Verify**: a **real Hetzner control box** (`hub deploy hetzner --ref <branch>`), a box created from
the web UI / `POST /boxes` with two `sources.repos`, with the PC off. Push from each repo with
`git.pushMode` as configured, and confirm on GitHub.

### Phase 5b: hub-created repo-less (carry-only) boxes

Depends on Phases 2 (`BoxSources`) and 3 (API `sources`), not on multi-repo seeding. It shares
Phase 5's control box, so it runs right after it.

- `parseCreateBox` accepts `sources` with `repos: []` and a non-empty `carry`; neither is a `400`.
- CLI: upload approved carry to `boxes/<key>/carry/` in custody before posting (§3.3);
  `agentbox create --via-hub` with no repo in the cwd (or `--no-repo`) takes this path instead of
  refusing.
- Worker: no clone, an empty job dir plus staged carry, and a plain (non-git) seed.
  `CarrySource.from` is `custody`, so start/resync re-reads it with the PC off.
- Docs: `api.mdx` (`sources` with `repos: []`), `deployed-hub.mdx`.

**Verify**: on the **real Hetzner control box** from Phase 5, create a box from a folder with no git
repo, carrying a data file and an `agentbox.yaml` that declares one service. With the PC off:
the file is in the box, the service runs, `GET /boxes` shows `hasGit: false` and no `projectId`, and
the web UI shows no git actions. Stop/start the box with the PC still off: the carry is re-read
from custody (`ls`/`sha256sum` in the box, not the exit code).

### Phase 6: `git --repo`, timeline + PR per repo, tray

- `--repo` on `agentbox git *` and `repo` in the git route body; per-repo timeline facts and PR
  matching; `sources.repos[].pr`; the tray's per-repo PR badges and git submenu.

**Verify**: docker box + the control box from Phase 5: open a PR from each repo, see both on the
workspace timeline and in `GET /boxes`; the tray smoke (`project-tray-ui-smoke-test`) shows two
badges.

### Phase 7: carry provenance + docs sweep

- `CarrySource.from`; resync skips entries from another machine; `cli.mdx`, `configuration.mdx`
  (`repos:`), `api.mdx`, `deployed-hub.mdx`, `create-and-checkpoints.md`, `cloud-create-flow.md`
  updated for the declared model. Delete the `gitWorktrees`/`carry` write paths now that everything
  reads `sources`.

**Verify**: re-attach from PC B to a box created on PC A, `stop`/`start` from PC B. PC A's carry is
not re-copied from PC B's home, and the log says so.

---

## 8. Riskiest assumptions and decisions

### Riskiest assumptions

1. **The repo key can be computed on the PC and trusted by the hub.** Alias expansion needs the PC's
   `~/.ssh/config`. A wrong key (an alias that resolves differently on two PCs) silently splits or
   merges a project. Mitigation: keep the raw `url` beside the key and show both in `GET /checkouts`.
2. **Lowercasing paths is safe for every forge in use.** True for GitHub, believed true for
   GitLab/Bitbucket. Not checked for self-hosted Gitea or Azure DevOps.
3. **Docker multi-repo needs nothing new from git.** Several bind-mounted `.git` dirs from unrelated
   folders, each with a locked per-box worktree, should behave exactly like today's nested case, but
   no box has yet mounted two `.git` dirs from different parents. Phase 3 is where this shows.
4. **One lease per repo is acceptable on the control box.** A GitHub App installation token can cover
   several repos of one owner. Repos across owners/installations mean several leases and several
   failure points in one create.
5. **Same branch name across repos** does not collide with anything (each repo has its own refs).
   The risk is human: `-2` bumps can make the names differ per repo.

### Decisions (owner, 2026-11-21, on PR #419)

1. **`agentbox.yaml` of a multi-repo box**: the primary repo's only. Other repos' yamls are ignored,
   so services/tasks declared in a second repo do not run.
2. **Branch naming for new boxes**: `agentbox/<box>` in every repo, as cloud already does. Docker's
   `agentbox/<box>--<sub>` survives only on existing records.
3. **Docker and a repo with no local checkout**: refused in v1 with a clear error. A managed mirror
   under `~/.agentbox/repos/` is backlog item B3.
4. **Ports in the repo key**: dropped, so one repo over ssh:22 and https:443 is one key.
5. **Checkouts registry vs workspace `hosts`**: both kept, side by side, with the workspace scan
   feeding checkouts. Folding them together is backlog item B1.
6. **Checkpoints across PCs**: not in multi-PC Stage 1. Re-keying checkpoint names by the primary
   repo key is backlog item B2; v1 keeps `hashProjectPath(projectRoot)`.
7. **Repo-less boxes from the hub**: **accepted**. `POST /boxes` takes `sources` with `repos: []`
   and a non-empty `carry` (a carry-only box), carry going through a box-scoped custody prefix
   (§3.3). Service agents such as openclaw are already repo-less, so this extends an existing shape
   to the hub. Implemented in Phase 5b.

## 9. Backlog (deferred by the decisions above)

| # | Item | Why deferred | Touches |
|---|---|---|---|
| B1 | Fold `WorkspaceRecord.hosts[*].projectRoots` into the checkouts registry, so one store answers "where is repo R on machine M" and the workspace keeps only its project list | Decision 5: two stores side by side are fine while the registry proves itself; folding means migrating workspace records again right after #418 re-keyed them | `packages/relay/src/workspaces/types.ts` (`WorkspaceHost`), `workspace-store.ts` (`workspaceForBox`, `findWorkspaceContaining`), the CLI scan in `apps/cli/src/commands/workspace.ts` |
| B2 | Re-key checkpoint names by the primary `repoKey` instead of `hashProjectPath(projectRoot)`, so PC B can list and restore PC A's checkpoints | Decision 6: not needed for multi-PC Stage 1, where teleport means re-attach | `packages/sandbox-docker/src/checkpoint.ts:38`, `packages/sandbox-cloud/src/checkpoint.ts:102`, `packages/sandbox-remote-docker/src/index.ts:46`, `box.defaultCheckpoint*` lookups |
| B3 | Managed mirror under `~/.agentbox/repos/<repoKey>` so a docker box can include a repo the PC has never cloned | Decision 3: refuse first, add the mirror once multi-repo docker works with real checkouts | `packages/sandbox-docker/src/create.ts` (repo resolution), checkouts registry (the mirror reports as a checkout) |
| B4 | ~~Carry-only boxes from the hub~~: moved into the plan as Phase 5b (Decision 7) | | |
| B5 | `agentbox git push|pull --all` across a multi-repo box | Not needed for v1 (§5) | `apps/cli/src/commands/git.ts`, the git route |
