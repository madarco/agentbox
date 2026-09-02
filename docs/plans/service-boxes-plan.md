# Persistent boxes & service agents — implementation plan

Status: **not started**. This is the durable plan doc; update the phase status lines as work
lands. One session per phase.

> **Supersedes `docs/openclaw-hosting-plan.md`**, which scopes only OpenClaw and whose Phase 1
> was written against an agent catalog that now exists. Delete that file when Phase 6 lands.

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
| Config ownership | **3-way merge** — AgentBox overwrites only keys it wrote and the user hasn't changed |

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

baked factory base  ─┐
agentbox.yaml block ─┼──▶ 3-way merge vs last-render ──▶ ~/.<agent>/<config>   (per-box, isolated)
carried 0600 .env   ─┘

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

Status: **not started**.

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

## Phase 3 — layered config (factory base + overlay + 3-way merge)

Status: **not started**.

```ts
// AgentSyncSpec
configRender?: {
  file: string;                       // in-box absolute, e.g. ~/.openclaw/openclaw.json
  format: 'json' | 'json5' | 'yaml';
  baseAsset: string;                  // baked runtime asset, e.g. openclaw-base.json5
  overlayKey: string;                 // agentbox.yaml top-level key, e.g. `openclaw`
  validate?: string;                  // e.g. `openclaw config validate`
};
```

New **`agentbox-ctl agent render <id>`** (`packages/ctl/src/commands/agent-render.ts`). Renders
in-box so it is provider-uniform and re-runs on `agentbox-ctl reload`:

1. **base** — the baked factory asset. Never user-edited; regenerated every render.
2. **overlay** — the `agentbox.yaml` `<overlayKey>:` block, parsed as an opaque mapping
   (ctl does not need the tool's schema; `validate` is the real gate). Add `overlayKey` to
   `TOP_LEVEL_KEYS` (`packages/ctl/src/config.ts:677`) **from the descriptor**, not a hardcoded
   list. Unknown keys are already non-fatal warnings, so an older ctl degrades cleanly.
3. **3-way merge** — compare the live file against `~/.<agent>/.agentbox-render.json` (the last
   render we wrote). Overwrite a key only where `live == lastRendered`; leave a key the user
   changed in-box, and report it as a conflict. This is what survives the tool adding new
   default keys on a future update — the reason the mechanism exists at all.
4. `resolveAutoSecrets` (`packages/ctl/src/secret.ts`) for `{{AGENTBOX_AUTO_SECRET:…}}`
   (0600 under `/var/lib/agentbox/secrets/`) and `applyReplacements` +
   `placeholderContextFromEnv` (`packages/ctl/src/replace.ts`, `packages/core/src/replace.ts`)
   for `{{AGENTBOX_*}}`.
5. Run `validate`; fail the task loudly on a bad merge.

**Secrets never go in `agentbox.yaml`.** Real values ride a `carry:` entry into a 0600 env file
(`packages/sandbox-core/src/sync/concerns/files.ts` `planCarryEntry`), and the overlay
references them by name. Add a lint that warns when a secret-shaped literal appears under the
overlay key.

Baked assets go through the collapsed manifest: `apps/cli/scripts/stage-runtime.mjs`
(`contextFiles` + `execBitFiles`), `DOCKER_CONTEXT_FILE_MAP`, and
`packages/provider-sdk/src/runtime-assets.ts`.

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

Status: **not started**. **Phase 0 gate first** (below) — anything that fails there changes this
phase.

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
  configRender: { file: `${BOX_HOME}/.openclaw/openclaw.json`, format: 'json5',
                  baseAsset: 'openclaw-base.json5', overlayKey: 'openclaw',
                  validate: 'openclaw config validate' },
  caps: { surface: 'service', resume: false, teleport: 'stub', activitySource: [] },
  // staticPaths: ~/.openclaw AND ~/.config/openclaw (the auth-profile key lives outside the state dir)
};
```

- Register in `BUILTIN_AGENT_SPECS` (`packages/agent-registry/src/index.ts:45`), the lazy
  `AGENT_MODULES` and eager `AGENT_COMMANDS` tables (`apps/cli/src/agents/{index,commands}.ts`),
  and the config mirror `AGENT_KINDS` (`packages/config/src/agents.ts:68`).
- Baked base asset `openclaw-base.json5`: `gateway.mode=local` (the gateway refuses to start
  without it), `gateway.port=18789`, token as a SecretRef fed by
  `{{AGENTBOX_AUTO_SECRET:openclaw-gateway}}` (auth is **mandatory** — `gateway.bind` resolves to
  `0.0.0.0` in a container and OpenClaw refuses a non-loopback bind without it),
  `agents.defaults.workspace=/workspace`.
- `agentbox openclaw url` prints the Control UI URL **and the gateway token**, which the UI needs
  pasted in.
- Add the shape to the setup skill (`apps/cli/share/agentbox-setup/SKILL.md` + the per-provider
  mirrors under `apps/cli/runtime/*/agentbox-setup-skill.md`).

---

## Phase 7 — provider parity: hetzner, remote-docker, digitalocean

Status: **not started**.

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

## Phase 0 — the PoC gate (do this before Phase 6, not before Phase 1)

Phases 1–5 are provider/product work and need no OpenClaw facts. Phase 6 does. Validate by hand
inside a docker box (`agentbox claude --shared-docker-cache --carry-yes`) and record results
here:

1. `npm i -g openclaw --allow-scripts=openclaw` on the box's Node. **Check the engine range** —
   OpenClaw needs `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`, and the box installs NodeSource
   `setup_24.x`; confirm the resolved 24.x is `>= 24.15.0`. Measure the image-size delta (~87 MB
   unpacked).
2. Headless bootstrap: `openclaw onboard --non-interactive --accept-risk --mode local
   --skip-channels --skip-health --no-install-daemon` (`--non-interactive` *requires*
   `--accept-risk`).
3. `OPENCLAW_WORKSPACE_DIR=/workspace` is honoured and does not fight the agent bootstrap files.
4. `openclaw gateway` binds `0.0.0.0:18789`, `/healthz` answers, Control UI renders through the
   box web proxy on 80.
5. A hand-merged config passes `openclaw config validate`; `openclaw channels add --channel
   telegram --use-env` works non-interactively.
6. **Which dirs must survive a restart** — stop/start and re-check pairing. Confirms the
   `staticPaths` set (`~/.openclaw` *and* `~/.config/openclaw`).
7. **New, for clone:** a second box seeded from the same workspace files onboards cleanly and
   does not inherit the first box's gateway identity.

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

Unit tests: `pnpm test` — `agent-command-coverage`, `agent-caps-wiring`, `schema-drift`,
`runtime-assets`, and `agent-credentials` all fail until updated; that is the intended forcing
function. Then `pnpm typecheck` (tsup does not typecheck and CI runs it), and format only touched
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
- **Node engine range and image size** for OpenClaw — ~87 MB shifts the build-context
  fingerprint, so every provider's base snapshot goes stale and the `box-image` CI tag moves.
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
