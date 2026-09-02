# Persistent boxes & service agents — implementation plan

Status: **in progress** (Phases 0, 2, 3, 6, 7 and 8 done; Phases 1, 4 and 5 not started). This is
the durable plan doc; update the phase status lines as work lands. One session per phase.

> Superseded `docs/openclaw-hosting-plan.md`, which scoped only OpenClaw and whose Phase 1 was
> written against an agent catalog that now exists. **Deleted with Phase 6.**

---

## Context

AgentBox hosts **coding agents** today: short-lived, interactive, git-backed, one TUI per box,
reaped when idle. Three real workloads don't fit that shape:

- **OpenClaw** — an always-on multi-channel AI gateway (`npm i -g openclaw`, MIT). One
  long-running daemon on `:18789` with a Control UI, `/healthz`, and live channel connections.
- **t3code backend** and **Hermes backend** — the user's own servers. They start, need their
  config and workspace synced in, expose a port the main app dials, and some serve a dashboard
  on 80. No TUI at all.

All three are the same shape and share four needs the product does not meet:

1. **Persistent boxes.** Not expendable — always on, never idle-reaped, back after a reboot.
2. **A non-TUI agent surface.** Something between an agent and a service.
3. **Workspace sync in *and* out**, on a live box, including non-git workspaces.
4. **Config layered over a factory default**, so the tool underneath can be updated later
   without losing the user's customisations. (Doing the update is out of scope; the mechanism
   that makes it possible is not.)

Plus **clone**: stand up a second box from the same workspace files (skills, scripts, documents)
and the same `agentbox.yaml` config, with a **fresh agent identity** — a new tenant from a
template, not a replica.

The plan builds two reusable primitives and lands OpenClaw as the first consumer. **t3code and
Hermes then need no new code** — Phases 1, 4 and 5 plus their own `agentbox.yaml`.

### Decisions taken

| Decision | Choice |
|---|---|
| Shape | Generic primitives (**persistent box**, **service agent**), OpenClaw first |
| Providers | **docker**, **hetzner**, **remote-docker**, **digitalocean** |
| `agentbox clone` | Workspace + `agentbox.yaml`, **fresh agent identity** — no `--with-state` |
| Config ownership | **Overlay via the tool's own validated merge** — AgentBox re-applies only the overlay keys that changed since its last render, so in-box edits survive (Phase 0 finding) |

**Why those four providers:** hetzner and digitalocean are real always-on VPSes with no session
cap; remote-docker is a machine the user already owns (always-on for free, docker-shaped image
and checkpoints); docker is the local always-on case and the fast iteration loop. **e2b and
vercel are deliberately excluded** — their microVMs carry hard session caps (E2B Hobby 1h,
Vercel Hobby ~45m) that `cloud-keepalive.ts` can only extend, never remove. `--persistent`
refuses on those two, by name, with the cap in the message.

### What already exists (reuse, don't rebuild)

The catalog work landed and is more capable than the old plan assumed:

- `AgentSyncSpec` (`packages/core/src/sync/agent-spec.ts:375`) is fully declarative — install
  recipe, credential, static paths, seeds, settings, pull, watch — and `AgentId` is an open
  string. An agent is a package (`packages/agent-registry/src/specs/*.ts`, and
  `agentbox agent add <pkg>` for out-of-tree ones).
- **ctl already pulls agent descriptors from the host over an `agents.list` RPC** at daemon
  start — `buildAgentDescriptors()` (`packages/sandbox-core/src/sync/agent-descriptor.ts:85`)
  → `packages/ctl/src/agent-registry.ts`. This exists precisely so a box whose `agentbox-ctl`
  was baked before an agent existed still learns about it. It is the seam Phase 2 extends.
- ctl's supervisor already has everything a service needs: DAG `needs:`, `restart: always`,
  `ready_when` (`port`/`http`/`log_match`), `expose: {port, as: 80}` → the box web URL, `run_once`
  markers, and `Supervisor.reload()` as an add/remove/change diff
  (`packages/ctl/src/config.ts`, `supervisor.ts:918`).
- `provider.resyncWorkspace` is **built and unused** for the host→live-box direction
  (`packages/core/src/provider.ts:519`; `resyncBox()` at
  `packages/sandbox-docker/src/lifecycle.ts:366` has zero callers).
- Autopause and keepalive are **pure selectors** over `BoxScanEntry` / `KeepaliveScanEntry`
  (`packages/relay/src/autopause.ts:46`, `cloud-keepalive.ts:95,139`) — unit-tested, and the
  natural place for a pin.

### What does not exist

- No "never reap this box" concept anywhere (searched `neverPause`/`pinned`/`protected`).
- No docker `--restart` policy — a host reboot leaves every box stopped.
- No `agentbox sync` and no `agentbox clone`.
- Cloud `agentbox download` is a bulk overwrite: `--dry-run` throws, gitignore/`--pattern`
  are silently ignored (`apps/cli/src/commands/download.ts:82`).
- The CLI agent contract (`packages/cli-kit/src/agent-contract.ts`) is TUI-shaped and **not
  satisfiable** by a daemon: `AgentRuntime.startSession` must create a tmux session,
  `buildAttachArgv` must return an attach argv, and `factory.ts:56` hardcodes
  `detachable: true`. Create always ends in `attachWrapped` (`create-action.ts:806`).

---

## Design shape

```
                     ┌── caps.surface: 'tui'      → tmux + attachWrapped   (claude, codex, …)
AgentSyncSpec ───────┤
                     └── caps.surface: 'service'  → ctl unit + expose      (openclaw)
                                │
                                ├─ spec.service   ──▶ agents.list (schema 2) ──▶ ctl Supervisor
                                └─ spec.configRender ─▶ agentbox-ctl agent render <id>

host project dir ──create/clone──▶ /workspace ──expose 18789 as 80──▶ agentbox url
                 ◀──── download ──            (Control UI / dashboard / API port)
                 ────── sync ────▶

agentbox.yaml block  ─┐
last-applied overlay ─┼──▶ changed keys only ──▶ `<tool> config patch` ──▶ ~/.<agent>/<config>
carried 0600 .env    ─┘       (the TOOL validates + merges; per-box, isolated)

box.persistent: true ──▶ never autopaused, never idle-lapsed, skipped by prune,
                         restarted by the relay's boot reconcile
```

**Two primitives, three consumers:**

| | persistent box | service agent | clone | sync/download |
|---|---|---|---|---|
| OpenClaw | yes | yes | yes | yes |
| t3code backend | yes | — (plain `agentbox.yaml` service) | yes | yes |
| Hermes backend | yes | — | yes | yes |

---

## Phase 1 — persistent boxes

Status: **not started**. Provider-agnostic, no agent work. Ships value on its own: t3code and
Hermes are usable after this phase plus Phase 4.

- `BoxRecord.persistent?: boolean` (`packages/core/src/box-record.ts`), config key
  `box.persistent` (default `false`) + `--persistent` / `--no-persistent` on `create` and every
  agent command. Follows the `autoApproveHostActions` precedent: **resolved at create time and
  persisted on the record**, because the relay reads records, not project config.
- **Autopause** — `selectBoxesToPause` (`packages/relay/src/autopause.ts:46`) filters
  `entry.persistent`. Add the field to `BoxScanEntry` and its scanner.
- **Keepalive** — in `packages/relay/src/cloud-keepalive.ts`, `shouldIdlePause` returns `false`
  for a persistent box, and `selectBoxesToRenew` renews it on the same cadence regardless of
  agent state. A persistent box has no reporting agent (`activitySource: []`), so without this
  it looks permanently idle.
- **Provider guard** — `--persistent` on `e2b`/`vercel` refuses with the cap named
  (`box.e2bTimeoutMs` / the vercel session window). Not a warning: a silently-lapsing always-on
  box is worse than a refusal.
- **Boot reconcile** — a new `startPersistentBoxLoop` registered alongside the existing loops
  in `packages/relay/src/daemon.ts:100-125`: on daemon start and on a slow tick, any
  `persistent` box whose `provider.probeState` is not `running` gets `provider.start()`. This is
  the right mechanism rather than a docker `--restart` policy, because docker's own restart
  skips `startBox`'s `bindWorktrees` / `launchCtlDaemon` / port re-resolution
  (`packages/sandbox-docker/src/lifecycle.ts:428`) and would bring back a container with no
  `/workspace` and no supervisor.
- **Prune / destroy** — `pruneBoxes` (`packages/sandbox-docker/src/lifecycle.ts:846`) and the
  hub's `prune` route skip persistent boxes; `destroy` on one requires an explicit confirm even
  with `-y` unless `--force`.
- **Surface it** — `agentbox list` marker, `agentbox status`, and a `persistent` field on the
  hub `Box` payload (`GET /api/v1/boxes`). **Update `../agentbox-tray/CLAUDE.md`** — the payload
  is its contract.

Files: `packages/core/src/box-record.ts`, `packages/config/src/types.ts` +
`packages/config/schema/user-config.schema.json`, `packages/relay/src/{autopause,cloud-keepalive,daemon}.ts`,
`packages/sandbox-docker/src/lifecycle.ts`, `apps/cli/src/commands/{create,list,status,destroy,prune}.ts`,
`apps/hub/app/(dashboard)/api/v1/lib/validate.ts`, `apps/hub/lib/boxes/backend-types.ts`.

---

## Phase 2 — service agents in the catalog

Status: **done** (2026-09-02). The generic mechanism only — no service agent ships yet; openclaw is
still Phase 6. Two items moved to the backlog: the `AGENT` column / hub payload reading ctl service
state, and the hub's missing `stop` route.

**Declare the surface, don't branch on the id.**

```ts
// packages/core/src/sync/agent-spec.ts
export interface AgentCapabilities {
  /** 'tui' (default when absent) keeps every existing row unchanged. */
  surface?: 'tui' | 'service';
  resume: boolean; teleport: 'full' | 'stub'; activitySource: readonly (…)[];
}

export interface AgentServiceSpec {
  name: string;                                   // ctl unit name
  command: string | string[];
  env?: Record<string, string>;
  readyWhen?: { http?: string; port?: number; logMatch?: string };
  expose?: { port: number; as: number };          // `as` must be RESERVED_WEB_PORT (80)
  restart?: 'always' | 'on-failure' | 'never';
  needs?: string[];
  /** One-shot units run before the service — onboard, render. */
  tasks?: { name: string; command: string | string[]; runOnce?: 'marker' | { check: string } }[];
}
```

`AgentSyncSpec.service?: AgentServiceSpec`. It mirrors ctl's own `ServiceSpec`/`TaskSpec`
(`packages/ctl/src/config.ts`) one-for-one on purpose — the renderer is a field copy, not a
translation layer.

**Delivery into the box — extend `agents.list`, do not push a file.** Bump
`buildAgentDescriptors()` to `schema: 2` with the `service` block
(`packages/sandbox-core/src/sync/agent-descriptor.ts:85`), and teach
`packages/ctl/src/agent-registry.ts` to parse it. A pushed file would make its shape a contract
every provider (including community ones) has to implement; the RPC keeps it host-side. This is
also what lets a box booted from a snapshot baked before OpenClaw existed still run it.

*Timing:* the `agents.list` fetch is deliberately off the critical path (30s bound, failure keeps
the baked list — `agent-registry.ts` header). Keep that property: `Supervisor.init()` runs on the
workspace `agentbox.yaml` as it does today, and the descriptor's units are applied when they
arrive via the existing `Supervisor.reload()` diff (`supervisor.ts:918`). A name in
`/workspace/agentbox.yaml` **wins** over the synthesized one, so a user can always override.

**A CLI command factory for the service shape.** `buildAgentCommand`
(`apps/cli/src/agents/command/factory.ts`) and `AgentRuntime` stay untouched — a service agent
cannot satisfy them and should not try. New `buildServiceAgentCommand(spec)` in
`apps/cli/src/agents/command/`, sharing `options.ts` and the box-resolution half of
`create-action.ts` but ending at "service ready + URL printed" instead of `startSession` →
`attachWrapped`:

- bare `agentbox <agent> [box]` — create-or-resume the box, ensure installed, wait for the
  service, print the URL. Implies `--persistent`.
- `<agent> logs|status|restart|stop|url` — thin wrappers over the existing
  `GET/POST /api/v1/boxes/:id/services` and `agentbox logs`.
- No `login`, `attach`, `--resume`/`-c`, `--dangerously-skip-permissions`, `-i` queue jobs,
  teleport, or dashboard-compositor mode.

**Tests that must move with it:**

- `apps/cli/test/agent-command-coverage.test.ts:26` asserts *every* registry agent has an
  `attachWrapped`. Split the assertion by `caps.surface`.
- `apps/cli/test/agent-caps-wiring.test.ts`, the `agent-cli-surface.json` fixture, and the
  `no-agent-named-exports` allowlist.

**Status without a TUI.** `activitySource: []` already makes ctl skip session probing. Make
`agentbox list`'s AGENT column and the hub payload read the **ctl service state** for a
`surface: 'service'` agent (`ServicesResult`, `apps/hub/lib/boxes/backend-types.ts:46`) instead
of showing a permanent `unknown`.

**Isolation default.** A service agent's config volume must never be shared — two OpenClaw
gateways sharing a state dir share a gateway identity and channel pairings, which OpenClaw
forbids. Derive `isolate` from `caps.surface === 'service'` rather than adding a special-cased
`box.isolateOpenclawConfig` key.

---

## Phase 3 — layered config (overlay applied through the tool's own merge)

Status: **done** (2026-09-02). Delegated merge as written below; `resolveAutoSecrets` is wired but
unused by any shipping agent, and no baked base asset exists.

```ts
// AgentSyncSpec
configRender?: {
  file: string;                       // in-box absolute — for the reads we must do ourselves
  overlayKey: string;                 // agentbox.yaml top-level key, e.g. `openclaw`
  /** Merge is DELEGATED to the tool; it receives the overlay JSON on stdin. */
  applyCmd: string;                   // e.g. `openclaw config patch --stdin`
  dryRunFlag?: string;                // e.g. `--dry-run`
  validate?: string;                  // e.g. `openclaw config validate`
};
```

New **`agentbox-ctl agent render <id>`** (`packages/ctl/src/commands/agent-render.ts`), run
in-box so it is provider-uniform and re-runs on `agentbox-ctl reload`.

**Do NOT hand-roll a 3-way merge over a parsed config file.** Phase 0 established that openclaw
ships `config patch --stdin` — a *validated, recursive* merge it performs on its own file, with
`--dry-run`, which leaves untouched keys alone and reports whether a restart is needed. A tool
either offers such a command or it does not; the spec names it, and an agent without one simply
does not declare `configRender`. Delegating buys us no format parser, no conflict engine, no
shadow copy of the file — and, the real prize, a render that keeps working across the tool's own
config migrations, which is the entire point of this phase.

What ctl actually does:

1. **overlay** — read the `agentbox.yaml` `<overlayKey>:` block as an opaque mapping. Add
   `overlayKey` to `TOP_LEVEL_KEYS` (`packages/ctl/src/config.ts:677`) **from the descriptor**,
   not a hardcoded list. Unknown keys are already non-fatal warnings, so an older ctl degrades
   cleanly.
2. **diff against the last applied overlay** — `~/.<agent>/.agentbox-overlay.json` records the
   overlay as last applied. Send only the keys whose OVERLAY value changed. This is what honours
   the chosen semantics: AgentBox re-asserts a key when the user edits `agentbox.yaml`, and
   otherwise never fights an in-box edit. (Verified in Phase 0: a patch that does not name a key
   leaves a hand-edit to it intact.)
3. **apply** — `<applyCmd>` with the overlay JSON on stdin, preceded by a `dryRunFlag` pass whose
   failure aborts before anything is written. Persist the new overlay record only after a
   successful apply.
4. `applyReplacements` + `placeholderContextFromEnv` (`packages/ctl/src/replace.ts`,
   `packages/core/src/replace.ts`) for `{{AGENTBOX_*}}` in the overlay. **`resolveAutoSecrets` is
   not needed for openclaw** — onboard self-generates the gateway token; keep the hook available
   for a tool that needs one.
5. Run `validate` as the final gate and fail the task loudly.

**Secrets never go in `agentbox.yaml`.** Real values ride a `carry:` entry into a 0600 env file
(`packages/sandbox-core/src/sync/concerns/files.ts` `planCarryEntry`), and the overlay
references them by name. Add a lint that warns when a secret-shaped literal appears under the
overlay key.

No baked factory asset is needed for openclaw — `openclaw onboard` writes the factory default
itself. If a future agent does need one, it goes through the collapsed manifest
(`apps/cli/scripts/stage-runtime.mjs` `contextFiles`/`execBitFiles`, `DOCKER_CONTEXT_FILE_MAP`,
`packages/provider-sdk/src/runtime-assets.ts`).

`packages/ctl/schema/agentbox.schema.json` + `packages/ctl/test/schema-drift.test.ts` fail until
both halves are updated — that is the forcing function.

---

## Phase 4 — workspace sync, both directions

Status: **not started**. Needed by all three workloads; nothing here is OpenClaw-specific.

**4a. `agentbox sync [box]` — host → live box.** Wraps `provider.resyncWorkspace`
(`packages/core/src/provider.ts:519`), which is fully implemented for docker
(`packages/sandbox-docker/src/sync/in-box-git.ts:770`) and cloud
(`packages/sandbox-cloud/src/sync/workspace-resync.ts:63`) and today is reachable only from an
agent-session start after a down→up transition (`apps/cli/src/lib/resync-start.ts`). For a git
workspace this is ~20 lines over the existing `resyncBox()`.

The real work is the **non-git leg**, which does not exist: tar the host workspace honouring the
same excludes `download` uses, upload, overlay in-box (box wins on conflict, matching the git
path's semantics). Both legs behind `POST /api/v1/boxes/:id/sync` so the web UI and tray get it.

**4b. `agentbox download` parity on cloud.** Today the cloud branch is a bulk overwrite:
`--dry-run` throws and gitignore/`--pattern`/`--include-node-modules` are silently ignored
(`apps/cli/src/commands/download.ts:82` → `pullCloudDirContents`,
`packages/sandbox-cloud/src/cloud-cp.ts:144`). Close it by **sharing the second half of the
docker path** rather than writing a parallel one:

- Lift stage 2 of `pullToHost` (`packages/sandbox-docker/src/sync/host-export.ts:446` — the
  host-side `rsync -a --checksum --files-from=- --from0` into `box.workspacePath`, plus
  `parseItemizedChanges`) into `@agentbox/sandbox-core` as a shared concern.
- Cloud stage 1: compute the file list in-box (`git ls-files -z` when it is a repo, else `find`
  with the exclude list), tar **only** those paths, `backend.downloadFile`, extract into the
  same host scratch dir docker uses.
- Both providers then share stage 2 → `--dry-run` and the change list work on cloud for free.

**4c. Exclude defaults for non-git and for agent state.** In exclude-list mode, add the service
agent's own state paths (derived from `spec.staticPaths` / a new `pull.exclude`) plus
`*.sqlite*` and `media/`, so a state dir never lands on the host. Surface `(exclude-list mode)`
prominently — for these users it is the normal mode, not a fallback.

---

## Phase 5 — `agentbox clone`

Status: **not started**.

`agentbox clone <box> [--name <n>] [--provider <p>] [--no-persistent]`:

1. Resolve the source box + its agent and project.
2. **Export its workspace** to a host scratch dir using the Phase-4b shared stage — gitignore
   and exclude aware, and dropping the agent's state paths. This is the "skills, scripts,
   documents" that must be carried.
3. **Create a new box seeded from that dir** — `seedWorkspaceFromDir` (docker,
   `packages/sandbox-docker/src/create.ts`) or the non-git leg of `seedCloudWorkspace`
   (`packages/sandbox-cloud/src/sync/workspace-seed.ts`).
4. **Do not copy the agent's config volume or credential.** The new box runs the service spec's
   `runOnce` onboard task fresh, so it gets its own identity, its own auto-secret token, and no
   channel pairings.
5. The `agentbox.yaml` overlay is *in* the workspace, so the config customisations travel for
   free — which is exactly the requirement.

**No `--with-state`.** A replica would give two live gateways one identity, which is the failure
mode OpenClaw explicitly forbids; box→box migration is the checkpoint path's job, not clone's.

Wire it as `POST /api/v1/boxes/:id/clone` returning a create job, so the CLI, web UI and tray all
get it from one implementation (per `docs/hub-api-single-path-plan.md`).

---

## Phase 6 — OpenClaw as the first service agent

Status: **done** (2026-09-02). Live-smoked on docker; the VPS providers are a backlog follow-up.
Two things differ from the sketch below, both recorded in place: the row also declares
`service.urlFields` (a new, generic field — see the note after the sketch), and `~/.config/openclaw`
is `relocToSubpath`'d under the state root rather than given its own `boxDir`, because a docker
volume can only be mounted once.

New package `packages/agent-openclaw`, mirroring `packages/agent-example` (the smallest
template):

```ts
export const openclawSpec: AgentSyncSpec = {
  id: 'openclaw', aliases: [], sessionName: 'openclaw', binary: 'openclaw',
  install: {
    recipe: { kind: 'npm', package: 'openclaw', allowScripts: true },   // lifecycle scripts — load-bearing
    runAs: 'root',
    postInstall: agentDirPrelude([`${BOX_HOME}/.openclaw`, `${BOX_HOME}/.config/openclaw`], 'openclaw').join(' && '),
  },
  boxRunEnv: { OPENCLAW_WORKSPACE_DIR: '/workspace' },
  service: {
    name: 'openclaw', command: 'openclaw gateway', restart: 'always',
    needs: ['openclaw-render'],
    readyWhen: { http: 'http://127.0.0.1:18789/healthz' },
    expose: { port: 18789, as: 80 },
    tasks: [
      { name: 'openclaw-onboard', runOnce: 'marker',
        command: 'openclaw onboard --non-interactive --accept-risk --mode local --skip-channels --skip-health --no-install-daemon' },
      { name: 'openclaw-render', command: 'agentbox-ctl agent render openclaw', needs: ['openclaw-onboard'] },
    ],
  },
  configRender: { file: `${BOX_HOME}/.openclaw/openclaw.json`, overlayKey: 'openclaw',
                  applyCmd: 'openclaw config patch --stdin', dryRunFlag: '--dry-run',
                  validate: 'openclaw config validate' },
  caps: { surface: 'service', resume: false, teleport: 'stub', activitySource: [] },
  // staticPaths: ~/.openclaw AND ~/.config/openclaw (the auth-profile key lives outside the state dir)
};
```

- Register in `BUILTIN_AGENT_SPECS` (`packages/agent-registry/src/index.ts:45`), the lazy
  `AGENT_MODULES` and eager `AGENT_COMMANDS` tables (`apps/cli/src/agents/{index,commands}.ts`),
  and the config mirror `AGENT_KINDS` (`packages/config/src/agents.ts:68`).
- **No baked base asset, no AUTO_SECRET, no bind override.** Phase 0 settled all three: `onboard`
  writes `gateway.mode=local`, `gateway.port=18789`, `agents.defaults.workspace=/workspace` and a
  self-generated auth token on its own, and binds **loopback**, which ctl's `WebProxy` reaches
  from inside the same container. Overriding `gateway.bind` would only widen exposure.
- `agentbox openclaw url` prints the Control UI URL **and the gateway token**, which the UI needs
  pasted in. **Read the token from the raw `openclaw.json`** — `openclaw config get
  gateway.auth.token` returns `__OPENCLAW_REDACTED__`.
- `staticPaths`/`pull` must EXCLUDE `~/.openclaw/tmp/openclaw-<uid>/` — it holds lock sqlites and
  its name is keyed by the box user's uid, which differs per provider. `LIVE_DATABASE_EXCLUDES`
  already covers `*.sqlite*`.
- Add the shape to the setup skill (`apps/cli/share/agentbox-setup/SKILL.md`; the per-provider
  mirrors under `apps/cli/runtime/*/agentbox-setup-skill.md` are build output staged from it by
  `stage-runtime.mjs`, not files to edit).

**What the row actually needed beyond the sketch:**

- **`service.urlFields`** — a new generic field on `AgentServiceSpec`: `{ label, file, jsonPath }`,
  values `<agent> url` reads out of the daemon's own config file. Declared as data rather than an
  agent-specific `url` implementation, because the only per-agent parts are which file and which
  key. openclaw declares one (`gateway.auth.token`), the read is best-effort, and the URL and the
  extra lines go out in ONE write so `<agent> url | head -1` cannot EPIPE.
- **`~/.config/openclaw` is `relocToSubpath: 'xdg'` under the state root**, not its own `boxDir`.
  A docker volume can only be mounted once, and a second `$HOME` dir would live in the container's
  writable layer and be lost on re-create. The spec's `postInstall` symlinks
  `~/.config/openclaw -> ~/.openclaw/xdg`, which is the same arrangement opencode uses for its
  config dir.
- **A credential slot that names a path nothing writes.** `AgentSyncSpec.credential` is required and
  openclaw has no host-side credential; pointing it at `openclaw.json` would be actively wrong,
  because the credential watch is FANOUT by contract and would copy one box's gateway identity into
  every other box. Backlogged as "make `credential` optional".
- **`staticPaths[0].exclude` drops everything identity-bearing** (`openclaw.json`, the journal key,
  `state`, `migration`, `tmp`) so a host that runs openclaw itself never pushes its gateway identity
  into a box. What carries in is the user's `agents/` content, which is also the only thing
  `download openclaw` pulls back.
- **`surface: 'service'` on the `AGENT_KINDS` row**, so config generates no `box.isolateOpenclawConfig`
  key — isolation is derived from the surface and the key would be one the product ignores.
- **No CLI module and no attach wrapper**, which meant splitting `agent-module-table.test.ts` and
  `agent-session-name.test.ts` by surface the way `agent-command-coverage.test.ts` already was.

---

## Phase 7 — provider parity: hetzner, remote-docker, digitalocean

Status: **done** (2026-09-02) — and most of it turned out to be **already true**. The list below is
kept as written, annotated with what was actually needed. The finding worth carrying forward: every
per-agent table this phase expected to hand-edit has since become registry-derived, so a service
agent reaches every provider from its row alone. Documented in
[`../cloud-providers.md`](../cloud-providers.md) §1.0.2.

- **Creds dir + symlink in each install script — NOT NEEDED.** Both
  `packages/sandbox-{hetzner,digitalocean}/scripts/install-box.sh` already say so in a comment: the
  per-agent home dirs and `~/.agentbox-creds/<agent>/` pivots belong to the agent and are created by
  its `install.postInstall`, applied by whichever path adds it (derived bake, or
  `ensureAgentInstalled` against a live box). Adding them here would put every agent's credential
  path in every box and be a second copy to keep in step.
- **`runtime-assets.ts` + their tests — NOT NEEDED.** openclaw adds no baked asset (Phase 0 settled
  that there is no factory config to bake — `onboard` writes it), so neither provider's pinned asset
  list changes. The one asset whose CONTENT changed is `agentbox-setup-skill.md`, which is staged
  from `apps/cli/share/agentbox-setup/SKILL.md` by `stage-runtime.mjs`; the per-provider mirrors
  under `apps/cli/runtime/*/` are build output, not files to edit.
- **`sandbox-cloud`'s second per-agent table — GONE.** `AGENT_SPECS` is now `agentSpecs()`, derived
  from `AGENT_SYNC_SPECS` (`staticPaths[0].boxDir`, `credential.cloudMountPath`,
  `credential.cloudSubpath`), and `test/agent-credentials.test.ts` asserts exactly that. openclaw
  got its mount with no edit.
- **`host-stage.ts` absent-tolerance — ALREADY TRUE, now pinned.** `stageAgentStaticForUpload`
  returns `emptyResult()` when no source dir exists. A test was added
  (`sandbox-cloud/test/agent-static-all.test.ts`) asserting openclaw specifically stages to
  `tarballPath: null` with no warnings against an empty host home, so a future per-agent stager
  cannot quietly make it an error.
- **What DID need doing:** the docker agent module has to return `spec.boxRunEnv` as its `env` — the
  clouds merge that field at provision time (`agentRunEnv`) but docker only gets it through the
  module. Returning `{}` is how `OPENCLAW_WORKSPACE_DIR` went missing on docker while every cloud
  box had it, caught by the live smoke and now pinned by `CLAW-006` and a unit test.
- **Not run from inside a box:** the hetzner/digitalocean re-bake and the VPS live checks. Exact
  commands in [`service-boxes-backlog.md`](./service-boxes-backlog.md).

### As originally written

- Creds dir + symlink and the new baked asset in each install script —
  `packages/sandbox-hetzner/scripts/install-box.sh`, the digitalocean equivalent. The **binary
  install is not added here**: it comes from the catalog, on demand via `ensureAgentInstalled` or
  through the derived agent variant.
- `packages/sandbox-{hetzner,digitalocean}/src/runtime-assets.ts` + their
  `test/runtime-assets.test.ts` (each pins the exact asset list and fails until updated).
- `packages/sandbox-cloud/src/sync/agent-credentials.ts` — the **second** per-agent table
  (`AGENT_SPECS`) needs the openclaw row; `test/agent-credentials.test.ts` cross-checks it
  against `AGENT_SYNC_SPECS` and fails on drift.
- `packages/sandbox-core/src/sync/host-stage.ts` — an openclaw entry in `stageAllAgentStatic`,
  **absent-tolerant**: most hosts have no `~/.openclaw`, and that must be a clean no-op.
- **remote-docker** is the odd one: docker-shaped image and checkpoints, cloud-shaped workspace
  sync (a bind mount can't cross a network). It is therefore the main consumer of Phase 4's
  non-git sync leg — verify it there specifically.
- Re-run `agentbox prepare` for hetzner and digitalocean. **Watch `box.image` collisions** — a
  cloud `prepare` that writes the generic project `box.image` with a provider-native snapshot id
  breaks creates on the other providers (`config unset box.image --project` to recover).

---

## Phase 8 — docs (same change, not a follow-up)

Status: **done** (2026-09-02), for the parts Phases 6-7 shipped. The `agentbox sync`, `agentbox
clone` and `--persistent` reference entries below belong to Phases 1, 4 and 5 and are still open.

- `apps/web/content/docs/**` — a **persistent boxes** page, a **service agents** page (with the
  t3code/Hermes `agentbox.yaml` worked example — it is the case that needs no new code), an
  OpenClaw page, and CLI reference entries for `agentbox sync`, `agentbox clone`,
  `agentbox openclaw`, `--persistent`, and the new config keys. Plus `meta.json`.
- `docs/architecture.md`, `docs/sync-architecture.md`, `docs/cloud-providers.md`,
  `docs/agents.md` (the service-agent surface), `docs/test-plan.md`, `CLAUDE.md`, and
  `plugins/agentbox/skills/agentbox-info/SKILL.md`.
- Delete `docs/openclaw-hosting-plan.md`.
- `../agentbox-tray/CLAUDE.md` — the `Box` payload gains `persistent`, and clone/sync are new
  routes.

---

## Phase 0 — PoC results (RUN 2026-09-02, openclaw 2026.8.2, node 24.18.0)

Status: **done**. Run in a throwaway `agentbox/box:dev` container. Several results change the
phases below — read this before starting Phase 3 or Phase 6.

| # | Assumption | Result |
|---|---|---|
| 1 | Node engine range | **OK.** Box ships node 24.18.0; range is `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0`. |
| 2 | `npm i -g openclaw` size | **~87 MB was wrong: 893 MB installed** (206 MB unpacked tarball + 331 deps). |
| 3 | `--allow-scripts=openclaw` | Valid on npm 11.16.0, but covers only openclaw's OWN scripts. **4 dependency install scripts are skipped**: `koffi` (native FFI), `tree-sitter-bash` (node-gyp-build), `protobufjs`, `@google/genai`. openclaw still installs, launches and serves. |
| 4 | Headless onboard | **Works.** `openclaw onboard --non-interactive --accept-risk --mode local --skip-channels --skip-health --no-install-daemon` exits 0. |
| 5 | `OPENCLAW_WORKSPACE_DIR=/workspace` | **Honoured** — onboard prints `Workspace OK: /workspace` and writes `agents.defaults.workspace`. |
| 6 | Gateway bind | **The plan was wrong.** It binds `127.0.0.1`/`[::1]` only (`gateway.bind: "loopback"`), NOT `0.0.0.0`. |
| 7 | Gateway auth | **Onboard self-generates a token** (`gateway.auth.mode: token`). |
| 8 | Health endpoints | `/healthz`, `/readyz` and `/` all return **200**; gateway reaches `ready` in ~1s. |
| 9 | Config validate | `openclaw config validate` exists and passes. |
| 10 | Fresh identity | Two onboards under different HOMEs produce **different gateway tokens** — clone gets a distinct identity for free. |

**The three findings that change the design:**

- **`openclaw config patch --stdin` is a validated recursive merge, performed by openclaw itself**
  ("Objects merge recursively, arrays/scalars replace, null deletes a path"), with `--dry-run`, and
  it reports whether a gateway restart is needed. Verified: a patch that does not name a key leaves
  a user's hand-edit to that key intact. **Phase 3 therefore delegates the merge to the tool**
  instead of hand-rolling a 3-way merge over a parsed file — see Phase 3.
- **Loopback bind + a self-generated token means the `{{AGENTBOX_AUTO_SECRET}}` / mandatory-auth /
  `0.0.0.0` machinery in the original plan is unnecessary.** ctl's `WebProxy` forwards
  `:80 -> 127.0.0.1:<port>` inside the same container, so a loopback gateway is reachable and
  strictly safer. Do not override `gateway.bind`.
- **`openclaw config get gateway.auth.token` returns `__OPENCLAW_REDACTED__`.** `agentbox openclaw
  url` must read the token from the raw JSON file, not via the CLI.

**Layout confirmed** (for `staticPaths` / `pull` / download excludes):

```
~/.openclaw/openclaw.json            config (JSON, not JSON5 on disk)
~/.openclaw/openclaw.json.bak        onboard's own backup
~/.openclaw/config-journal-fingerprint.key
~/.openclaw/state/openclaw.sqlite    (+ -wal, -shm)
~/.openclaw/agents/<id>/…            per-agent dirs
~/.openclaw/migration/
~/.openclaw/tmp/openclaw-<UID>/…     EXCLUDE — lock sqlites, and the dir name is keyed by the
                                     box user's uid, which differs per provider (docker 1000,
                                     vercel 1001, e2b 1002)
~/.config/openclaw/                  EMPTY after onboard; still persisted for the auth-profile key
```

A direct out-of-band edit of `openclaw.json` is accepted (`config validate` and `config get` both
honour it) — the config-journal fingerprint does not reject external writes.

**Still unverified** (needs a real credential, deferred to Phase 6): `openclaw channels add
--use-env`, and which dirs a channel PAIRING actually needs to survive a restart.

---

## Verification

Start slow commands in the background and tail `~/.agentbox/logs/latest.log`; do not pick a blind
timeout.

```sh
# Phase 1 — persistence (no agent work needed)
node apps/cli/dist/index.js create -y -n persist-smoke --persistent &
tail -f ~/.agentbox/logs/create.log
node apps/cli/dist/index.js list                       # persistent marker present
node apps/cli/dist/index.js relay restart              # boot reconcile brings a stopped one back
node apps/cli/dist/index.js create -y --provider e2b --persistent   # must REFUSE, naming the cap

# Phase 4 — sync/download round-trip on a NON-GIT workspace (the whole point)
mkdir /tmp/svc-ws && cd /tmp/svc-ws                    # no .git on purpose
node apps/cli/dist/index.js create -y -n svc --persistent
#   … edit files on the host …
node apps/cli/dist/index.js sync svc                   # host -> box
#   … edit files inside the box …
node apps/cli/dist/index.js download --dry-run         # change list non-empty and CORRECT
node apps/cli/dist/index.js download -y                # lands back in /tmp/svc-ws
#   repeat against --provider remote-docker and --provider digitalocean

# Phase 5 — clone
node apps/cli/dist/index.js clone svc --name svc2
node apps/cli/dist/index.js shell svc2 -- ls /workspace      # same files
#   … and the agent state dir is EMPTY / freshly onboarded

# Phase 6/7 — openclaw
node apps/cli/dist/index.js openclaw -y -n claw &
tail -f ~/.agentbox/logs/latest.log
node apps/cli/dist/index.js services claw              # openclaw service == ready
curl -fsS "$(node apps/cli/dist/index.js url claw)/healthz"   # ground truth, not an exit code
#   edit agentbox.yaml `openclaw:` -> agentbox-ctl reload -> re-render -> config validate
#   then hand-edit a key IN THE BOX and re-render: the hand edit must survive (3-way merge)
node apps/cli/dist/index.js openclaw --provider hetzner -y -n claw-hz    # same checks
```

### Phase 6/7 — openclaw, live on docker (RUN 2026-09-02, all green)

Run from a small scratch workspace, not the agentbox repo itself (the repo's `/workspace` is big
enough that the create-time tar of it reset the connection — unrelated to openclaw). The hub must be
running: the service path polls the supervisor through `/api/v1`.

1. `agentbox openclaw -y -n claw3` — derived `agentbox/box:dev-openclaw` layer built (openclaw
   installed on demand, not in the base), config volume created with
   `no host ~/.openclaw + ~/.config/openclaw`, then `waiting → running → openclaw ready`, and the
   outro printed the token above the URL.
2. `agentbox services claw3` → the `openclaw` row is `ready`. `agentbox status` shows both one-shot
   tasks `done 0`: `openclaw-onboard` then `openclaw-render`.
3. **Ground truth, not exit codes:** `curl "$(agentbox openclaw url | head -1)/healthz"` → **200**;
   `/readyz` → 200; `/` → 200. `url | head -1` exits 0 and prints only the URL.
4. The printed token matched `~/.openclaw/openclaw.json`'s `gateway.auth.token` byte-for-byte.
   `gateway.bind` is `loopback` and `gateway.port` is 18789 — neither touched by us.
5. **Layered config, both directions.** The `agentbox.yaml` `openclaw:` block reached the config
   (`applied 1 key(s): logging`). Then a hand edit in the box to an unrelated valid key
   (`tools.profile: coding → full`) plus an overlay change (`logging.level: debug → info`) and a
   re-render: `applied 1 key(s): logging.level`, `logging.level` became `info`, **the hand edit
   survived**, and `openclaw config validate` passed.
6. **The gate works.** An earlier attempt hand-edited two keys openclaw's schema rejects; the
   render's `--dry-run` pass refused with openclaw's own message
   (`logging: Unrecognized key: "format"`, `<root>: Unrecognized key: "handEdited"`), exited 1, and
   wrote nothing.

Two things the smoke caught that unit tests could not:

- **`OPENCLAW_WORKSPACE_DIR` was not reaching a docker box.** The agent's docker module returned
  `env: {}`, so `boxRunEnv` never made it onto `docker run` and onboard wrote
  `agents.defaults.workspace = ~/.openclaw/workspace`. The clouds merge that field at provision time,
  so this was docker-only drift. Fixed by returning `spec.boxRunEnv`; pinned by a unit test and
  `CLAW-006`.
- **`agentbox-ctl reload` does not re-run the render.** Reload applies the unit diff and the render
  task's definition has not changed. The working command is
  `agentbox-ctl run-task openclaw-render --force`; the docs say so, and making reload smarter is a
  backlog item.

### Phases 2-3 — the mechanism, without a real agent (RUN 2026-09-02, all green)

No service agent ships yet, so the smoke runs the REAL `agentbox-ctl daemon` against a throwaway
one: a stub host relay answering `agents.list` with a schema-2 payload, and a `demosvc` script that
implements the two things the design delegates (`config patch --stdin [--dry-run]`, `config
validate`) plus a gateway with a `/healthz`. What it proved:

1. `agent units applied: demosvc, demosvc-onboard` — the daemon came up on the workspace yaml
   first, then folded the synthesized units in through `Supervisor.reload()`; the one-shot task ran,
   the http probe reached `ready`, and `/healthz` answered 200.
2. A `demosvc:` service in the workspace `agentbox.yaml` won: reload reported `changed: demosvc`,
   the workspace command was the one running, and the daemon warned which unit it dropped.
3. `agent render demosvc` applied the overlay through `demosvc config patch --stdin`, resolved
   `{{AGENTBOX_BOX_NAME}}`, and left `gateway.port` (never named) alone.
4. After a hand edit in the box, a re-render sent ONLY `channels.telegram.enabled` — the hand-edited
   `logging.level` survived, and so did `channels.telegram.name`, a key the overlay names but did
   not change.
5. Gates: an invalid overlay was rejected by the tool's own `--dry-run` with nothing written and the
   record left at its old value; removing a key sent `null` and restored the tool's default; a
   secret-shaped literal warned; a failing `validate` failed the render loudly. All exit 1.

Unit tests: `agent-command-coverage`, `agent-caps-wiring`, `service-agent-command`, `agent-units`,
`overlay-diff`, `schema-drift`, and `agent-registry-fetch` — 450 in `@agentbox/ctl`, 151 across the
CLI's agent suites. Run one package at a time with a worker cap
(`npx vitest run --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2`): a
bare `pnpm test` spawns one worker per CPU and OOMs the box. Then `pnpm typecheck` (tsup does not typecheck and CI runs it), and format only touched
files with `npx prettier --write <files>` — `pnpm format` rewrites ~530 unrelated files.

---

## Risks / confirm early

- **The keepalive inversion is the subtle one.** A persistent box has no reporting agent, so
  every existing idle heuristic reads it as abandoned. Phase 1's two selector changes are small
  but load-bearing; their unit tests (`packages/relay/test/{autopause,cloud-keepalive}.test.ts`)
  are the guard.
- **ctl reaches the supervisor asynchronously.** The `agents.list` reconcile is deliberately
  non-blocking; routing service units through `Supervisor.reload()` preserves that, but it means
  a first boot has a short window with no service. Verify the window is bounded and that a
  failed fetch leaves a *usable* box, not a half-configured one.
- **Only one service may `expose:`** (`packages/ctl/src/config.ts:810`). A service agent that
  exposes 80 conflicts with a workspace `agentbox.yaml` that already does. Decide the precedence
  explicitly and make the collision an error with a clear message, not a silent drop.
- **OpenClaw is 893 MB installed**, not the ~87 MB the old plan assumed (Phase 0 #2). That is a
  ~29% increase on a 3.1 GB base image. It is the strongest argument for keeping the install
  **on demand** and NOT baking openclaw into a base variant by default; if a variant is ever
  baked it shifts the build-context fingerprint, staling every provider's base snapshot and
  moving the `box-image` CI tag.
- **`--allow-scripts=openclaw` does not cover dependency scripts.** Four are skipped, two of them
  native builds (`koffi` FFI, `tree-sitter-bash`). openclaw installs and serves anyway in the
  PoC, but any feature routed through those deps may be silently degraded. Decide in Phase 6
  whether to broaden the allowlist, and smoke-test a real channel before calling it done.
- **WhatsApp pairing is QR-only and interactive.** It works through the Control UI in a browser
  (and the box now has a VNC desktop, which is a viable path), but token-based channels
  (Telegram/Discord, `channels add --use-env`) are fully scriptable and should be the documented
  default. The WhatsApp runtime is a separate plugin, not in the core package.
- **Multi-tenancy.** OpenClaw does not support multiple tenants in one gateway — one box per
  tenant is the only correct model, which is what per-box isolation and clone's fresh-identity
  semantics enforce.
- **Two `agentbox.yaml` parsers.** `@agentbox/ctl` owns `services`/`tasks`/`carry`/`replacements`;
  `@agentbox/config` owns `defaults:`. The new overlay key belongs to the ctl half only.

## References

- Repo: `github.com/openclaw/openclaw` · Docs: `https://docs.openclaw.ai`
- Superseded: `docs/openclaw-hosting-plan.md`
