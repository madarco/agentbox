# Provider descriptors: community providers in the tray, capabilities over the API

## Context

Community providers (external npm packages registered via `agentbox plugin add`) can already
be **created** through the hub: `POST /api/v1/boxes` accepts a plugin provider name
(`apps/hub/app/(dashboard)/api/v1/lib/validate.ts:76`), and `hub-worker.ts:302` loads the
module through `loadProviderModuleByName` (`apps/hub/lib/provider-importers.ts:63`). But they
are **invisible**: `listProviders` (`apps/hub/lib/hub-backend.ts:766`) maps over
`PROVIDER_NAMES` — built-ins only — so a plugin never reaches `GET /api/v1/providers`, and
therefore never reaches the tray's provider dropdown or the web create modal.

The second half of the problem is that AgentBox has **no declarative provider metadata**.
Today a provider's capabilities are expressed two ways, neither of which a client can read:

1. **Implicitly**, as optional-method presence on `Provider`/`CloudBackend` (`checkpoint?`,
   `sshTarget?`, `prepare?`, `setInbound?`, `backend.list?`).
2. **As hardcoded provider-name arrays** scattered across the CLI and hub — ~20 of them
   (`PERSISTENT_SSH_PROVIDERS`, `IDE_PROVIDERS`, `SSH_MOUNT_PROVIDERS`,
   `CLOUD_PRUNE_PROVIDERS`, `KNOWN_PROVIDERS`, `FORK_PROVIDERS`,
   `PROVIDERS_WITH_DIRECT_BOX_SSH`, `PROVIDER_CRED_KEYS`, plus per-name `switch`es in the
   tray). A plugin can never enter any of them, so it silently loses `open --in`, `code`,
   `prune`, `checkpoint set-default`, `fork`, SSH-config auto-write, and a credential form.

The tray mirrors this: `Menu/SettingsPanel.swift:31` hardcodes a `providerMeta` table of SF
Symbols + credential fields per provider id, and `CreateBoxPanel.swift:13` /
`SettingsPanel.swift:6` hardcode progress-bar pacing per provider id.

**Outcome:** one `ProviderDescriptor` shape that built-ins and plugins both declare, snapshotted
so every consumer can read it *synchronously and offline*, exposed over `GET /api/v1/providers`,
and consumed by the tray, the web UI and the CLI — replacing the name arrays. `bake-share.ts:23`
already states this principle ("derive the provider set from it, never a hardcoded list"); this
generalizes it.

---

## Design

### The descriptor — one shape for built-ins and plugins

New in `packages/config/src/providers.ts` (extends the existing `ProviderMeta`, which becomes
this):

```ts
export interface ProviderCredentialField {
  key: string;          // the key `ProviderModule.setCredentials` expects ('apiKey', 'token', 'teamId')
  label: string;
  optional?: boolean;
  secret?: boolean;     // default true; DigitalOcean's `project` is false (it lands in config, not secrets)
  hint?: string;
}

/** What a UI/CLI can know about a provider WITHOUT loading its module. */
export interface ProviderDescriptor {
  name: string;
  kind: 'local' | 'cloud';
  label: string;
  loginHint: string;
  blurb: string;
  credentials: {
    /** secrets.env key names whose presence means "credentials configured" (value never read). */
    envKeys: readonly string[];
    /** fields a UI prompts for; empty = no credentials needed (docker, remote-docker). */
    fields: readonly ProviderCredentialField[];
  };
  bake: {
    /** false = base self-heals on create (docker); true = must bake before first use. */
    required: boolean;
    approxMinutes: string;        // was `rebuildMinutes`
    /** Typical streamed-log line counts, for client progress pacing (tray). */
    createProgressSteps?: number;
    bakeProgressSteps?: number;
  };
  capabilities: ProviderCapabilities;
  /** Create-time knobs. Absent = free-form string the backend interprets. */
  sizes?: readonly { key: string; label: string }[];
  regions?: readonly { key: string; label: string }[];
  sizeDesc: string;               // unchanged — drives the box.size<P> KEY_REGISTRY entry
  imageDesc: string;              // unchanged — drives the box.image<P> KEY_REGISTRY entry
}

/**
 * All DECLARED. See "Why capabilities are declared, not derived" below — method
 * presence on `Provider` signals which scaffold a provider was built with, not
 * what it can do.
 */
export interface ProviderCapabilities {
  /** Checkpoint capture/restore is supported at all. */
  checkpoints: boolean;
  /** Capturing a checkpoint stops + reboots the box (vercel, daytona). */
  checkpointReboots: boolean;
  /** Real SSH into the box: `agentbox code` (IDE) and `open` (sshfs mount). */
  ssh: boolean;
  /** Per-box SSH identity outlives the CLI call (`open --in claude|codex`). */
  persistentSsh: boolean;
  /** `buildAttach` yields a plain `ssh user@host` at the box (cloud-ssh auto-config). */
  directBoxSsh: boolean;
  /** Per-box inbound firewall policy (`--inbound`, `agentbox inbound`). */
  inbound: boolean;
  /** `git.pushMode=direct` can be switched on post-create (`--with-credentials`). */
  directGit: boolean;
  /** Host->box workspace resync. */
  resync: boolean;
  /** Orphan sandboxes are enumerable + deletable (`prune --provider`). */
  prune: boolean;
  vnc: boolean;
  dind: boolean;
  /**
   * What `pause` does. 'freeze' preserves the running process tree (docker
   * pause, daytona linux-vm, vercel/e2b snapshot-resume); 'stop' powers the box
   * off and only the disk survives (hetzner, digitalocean — both literally
   * `pause ≡ stop`). NOT a gate on showing a pause control: powering a VPS down
   * is useful (it stops billing), so a UI should relabel, not hide.
   */
  pauseSemantics: 'freeze' | 'stop';
  /** Creates can be handed to a remote control box. */
  hubRoutable: boolean;
  /** Session-lifetime model, when the backend declares one. */
  timeoutModel?: 'absolute' | 'inactivity';
}
```

### Why capabilities are declared, not derived

The original design derived most of this from optional-method presence. **Probing the
real modules showed that does not work**, and the table is hand-authored instead:

- `packages/sandbox-cloud/src/cloud-provider.ts` unconditionally defines
  `repairReachability` (1448), `setInbound` (1454), `enableDirectGit` (1475) and `checkpoint`
  (1783) on *every* cloud provider, each delegating to an optional `backend.*?` at call time.
  So `!!provider.setInbound` is `true` for vercel and e2b, which have no firewall — the flag
  signals *"built on the cloud scaffold"*, not *"has this capability"*.
- `sandbox-docker`'s provider has **no** `checkpoint` key at all (verified: its keys are
  `create, destroy, downloadPath, exec, inspect, name, pause, prepare, probeState, reconnect,
  resolveUrl, resume, resyncWorkspace, start, stats, stop, sync, syncTransport, uploadPath`),
  yet docker checkpoints are the oldest feature in the repo — they run through a hardcoded
  `providerName === 'docker'` branch at `hub-backend.ts:2609`.
- `provider.prepare` is present on all seven including docker, so it cannot mean
  "must bake before first use".

The dividing line is **which object the method hangs off**. `CloudBackend` methods are written
by the provider author, so they are honest signals; `Provider` methods are supplied by the
scaffold, so they are not. Verified against the live backends:

| Derivation | Result | Verdict |
|---|---|---|
| `!!backend.list` | true for all 6 clouds, false for docker | matches `CLOUD_PRUNE_PROVIDERS` exactly ✓ |
| `!!backend.setInbound` | true for hetzner + digitalocean only | matches the `--inbound` reality exactly ✓ |
| `backend.timeoutModel` | `'inactivity'` for daytona + e2b | authoritative ✓ |
| `!!provider.setInbound` | true for **all 6 clouds** | scaffold artifact ✗ |
| `!!provider.checkpoint` | **false for docker** | wrong ✗ |
| `!!provider.prepare` | true for all 7 incl. docker | can't mean "must bake" ✗ |

So `prune`, `inbound` and `timeoutModel` are asserted by the guard test against the live
modules; every other capability is declared.

Derivation survives as the **fallback for a descriptor-less plugin**, where it is sound
precisely because such plugins are nearly always `createCloudProvider`-based — a scaffold-given
`checkpoint` really does work for them. It is the built-in table that can't be derived.

### Where descriptors live, and why everything stays synchronous

The load-bearing decision: **derived capabilities are computed once, at registration time, and
snapshotted** — so no consumer ever has to `import()` a provider to answer "does it support
checkpoints?".

- **Built-ins** declare the full descriptor in the `PROVIDERS` table
  (`packages/config/src/providers.ts`). A new vitest (`packages/config` can't import the
  provider packages, so this lives in `apps/cli/test/provider-descriptors.test.ts`) loads each
  built-in `ProviderModule` and asserts the *derived* half matches real method presence — drift
  fails CI instead of rotting.
- **Plugins** declare `ProviderModule.descriptor?: ProviderDescriptor` (declared half only).
  `agentbox plugin add` already imports and validates the module
  (`apps/cli/src/commands/plugin.ts:129` `loadAndValidate`) — it computes the derived half there
  and writes the merged descriptor into `~/.agentbox/plugins.json`.

`plugins.json` goes to `version: 2`: `PluginRecord` gains
`descriptors?: Record<string, ProviderDescriptor>` alongside the existing `providers: string[]`.
A v1 file still loads; see **Compatibility & migration** below for exactly what an
un-migrated plugin gets.

New sync resolver in `packages/sandbox-core/src/provider-descriptor.ts` (it can import both
`@agentbox/config` and the plugin registry; `@agentbox/config` must not import sandbox-core):

```ts
export function resolveProviderDescriptor(name: string): ProviderDescriptor | undefined;
export function listProviderDescriptors(): ProviderDescriptor[];   // built-ins ∪ registered plugins
export function deriveCapabilities(mod: ProviderModule): Partial<ProviderCapabilities>;  // used at plugin-add
```

`getRuntimeProviderNames()` (`apps/cli/src/provider/loaders.ts`) is already the
built-ins-∪-plugins name list; `listProviderDescriptors()` is its descriptor-shaped sibling.

### SDK impact

Additive only — `ProviderModule.descriptor` is optional, so `SDK_API_VERSION` **stays 2** and
`SUPPORTED_SDK_API_VERSIONS` is untouched. Bump `packages/provider-sdk/package.json` to `2.7.0`,
re-export `ProviderDescriptor`, `ProviderCredentialField`, `ProviderCapabilities`,
`resolveProviderDescriptor`, `listProviderDescriptors` from
`packages/provider-sdk/src/index.ts`, then rebuild + **republish** per
`docs/provider-plugins.md` → "Publishing the SDK".

---

## Compatibility & migration

**Nothing breaks, and no plugin author is required to act.** Three mechanisms, in order:

**1. The field is optional, in both directions.** An existing plugin (built against SDK `2.6.0`
or even `apiVersion: 1`) exports no `descriptor`; it still passes `loadAndValidate` and still
loads. A plugin built against `2.7.0` running on an older CLI has its `descriptor` ignored. No
`SDK_API_VERSION` bump means the `SUPPORTED_SDK_API_VERSIONS` gate never rejects anything it
accepts today.

**2. Auto-backfill, so migration is invisible.** When `resolveProviderDescriptor(name)` finds a
registered plugin with no snapshotted descriptor (a v1 `plugins.json`, or a plugin that declares
none), the first code path that loads the module anyway derives the derivable half and writes it
back to `plugins.json`. Users never run a migration command; `agentbox plugin add <pkg>` also
upserts. Consumers that must stay sync and have no snapshot yet fall through to (3).

**3. Fallback defaults reproduce today's behavior exactly — they are NOT "safe = false".**
This is the load-bearing rule. Every default below was chosen by asking "what does AgentBox do
for a plugin *today*?", because a `false` default on `vnc`/`realPause` would silently *remove*
working UI from an existing provider:

| Field | Fallback | Why that value preserves current behavior |
|---|---|---|
| `kind` | `backend ? 'cloud' : 'local'` | derived |
| `label` | provider name | what the UI shows today |
| `bake.required` | **`false`** | must **not** default true — the hub's create gate deliberately skips `isProviderConfigured` for plugins (`hub-backend.ts:2159`), so a `true` default would newly block creates. (`!!provider.prepare` is *not* usable: all seven built-ins including docker have `prepare`.) |
| `bake.approxMinutes` | `'1'` | matches `wizard.ts:372`'s existing plugin fallback |
| `credentials.fields` | `setCredentials ? [{key:'apiKey',label:'API key'}] : []` | matches the tray's current `metaFor` fallback (`SettingsPanel.swift:63`) |
| `credentials.envKeys` | `[]`, and `hasCredentials` answered by `ProviderModule.readCredStatus()` when present, else left **undefined** | `undefined` = "unknown", which consumers must treat as *don't block* — a `false` would disable the tray's bake button |
| `capabilities.vnc` | **`true`** | `createCloudProvider` wires VNC unconditionally and degrades best-effort; `false` would delete a working VNC button |
| `capabilities.dind` | **`true`** | `launchDockerd` defaults true in `cloud-provider.ts:127` |
| `capabilities.pauseSemantics` | **`'freeze'`** | the tray shows an unqualified Pause for every running box today |
| `capabilities.checkpoints` | `!!provider.checkpoint` | sound for a plugin (scaffold-based ⇒ working checkpoints); only *docker* breaks this derivation |
| `capabilities.prune` | `!!backend.list` | honest derivation |
| `capabilities.timeoutModel` | `backend.timeoutModel` | honest derivation |
| `capabilities.ssh` | `!!provider.sshTarget` | matches the existing escape hatch in `cloud-ssh.ts:153` |
| `capabilities.checkpointReboots` | `false` | the confirm prompt only fires for vercel/daytona today |
| `capabilities.directBoxSsh` / `persistentSsh` | `false` | plugins are excluded from those arrays today — `false` is the status quo, and a plugin opts *in* |
| `capabilities.inbound` / `directGit` / `resync` | `false` / `false` / `true` | **not** derived (the scaffold defines all three on every cloud provider); `resync: true` matches the scaffold actually providing it |
| `capabilities.hubRoutable` | `kind === 'cloud'` | matches `HUB_ROUTABLE_PROVIDER_NAMES` |

Net effect for an un-migrated plugin: it **gains** the dropdown, a credential form, and
`prune`/`checkpoint`/`fork` eligibility (all derived), and loses nothing. Declaring a descriptor
buys it a real label, correct SSH/pause/VNC gating, and size/region pickers.

A regression test pins this: `apps/cli/test/provider-descriptor-fallback.test.ts` feeds a
descriptor-less `ProviderModule` (the shape of a 2.6.0-era plugin) through the resolver and
asserts the table above.

---

## Phases

One phase per session. Tick a phase off here as it lands.

| # | Phase | Status |
|---|---|---|
| 1 | Descriptor type, built-in table, registry snapshot | done |
| 2 | Hub API serves plugin providers + capabilities | done |
| 3 | Tray consumes descriptors | done (agentbox-tray `3db893a`) |
| 4 | Retire the CLI provider-name arrays | done |
| 5 | Docs, web UI, changelog | done |

Live-verified against the published third-party `agentbox-provider-sprites`
(SDK v2, declares no descriptor): it lists as `configured`, derives
`prune`/`timeoutModel: inactivity` correctly from its backend, and
`prune --provider sprites` enumerated real orphan sandboxes — a command that
was rejected outright before. Two things its derived descriptor gets wrong that
only a declared one can fix: the guessed `apiKey` credential field (it wants
`SPRITE_TOKEN`) and `vnc: true` (Sprites ships no VNC stack and forces it off).

### Phase 1 — the descriptor + registry snapshot

Files:
- `packages/config/src/providers.ts` — `ProviderMeta` → `ProviderDescriptor`; fill all 7 rows
  (label/loginHint/blurb/sizeDesc/imageDesc already there). Move `PROVIDER_CRED_KEYS`
  (`apps/hub/lib/hub-backend.ts:661`) and the tray's `providerMeta` field specs
  (`agentbox-tray/Sources/AgentBox/Menu/SettingsPanel.swift:31`) into `credentials`. Keep
  `PROVIDER_NAMES` / `CLOUD_PROVIDER_NAMES` / `isProviderKind` / `perProviderConfigKey`
  unchanged. `HUB_ROUTABLE_PROVIDER_NAMES` derives from `capabilities.hubRoutable`.
- `packages/sandbox-core/src/plugin-registry.ts` — `PluginsFile.version: 2`, `PluginRecord
  .descriptors`, tolerant v1 read.
- `packages/sandbox-core/src/provider-descriptor.ts` — new resolver + `deriveCapabilities`.
- `apps/cli/src/commands/plugin.ts` — `loadAndValidate` merges declared + derived, passes to
  `addPluginRecord`. `plugin info` prints the descriptor.
- `packages/provider-sdk/src/index.ts` + `package.json` — re-export, `2.7.0`.
- `examples/agentbox-provider-example` — declare a descriptor (this is the E2E fixture).

Tests: `packages/sandbox-core/test/provider-descriptor.test.ts` (resolution order, v1
`plugins.json` read + auto-backfill), `packages/config/test/providers.test.ts` (the existing
drift test extends to the new fields), `apps/cli/test/provider-descriptors.test.ts` (built-in
declared-vs-derived guard), `apps/cli/test/provider-descriptor-fallback.test.ts` (the
descriptor-less-plugin defaults table from **Compatibility & migration** — this is the test that
proves old providers don't break).

### Phase 2 — hub API

- `apps/hub/lib/hub-backend.ts`
  - `listProviders` (766): iterate `listProviderDescriptors()` instead of `PROVIDER_NAMES`.
  - `isProviderConfigured` (650) → `descriptor.bake.required ? preparedBase : true`; keep the
    remote-docker host-count special case.
  - `hasProviderCredentials` (692) → `descriptor.credentials.envKeys`; delete
    `PROVIDER_CRED_KEYS`.
  - `preparePrecheck` (724), `providerBaseFreshness` (809), `listProvidersWithFreshness` (885),
    `providerBakeDiff` (911): `IMPORTERS[id]` → `loadProviderModuleByName(id)`; drop the
    `isProviderKind` guards; skip freshness when `!bake.required`.
  - `setProviderCredentials` (2270) / `prepareProvider` (2284): `isProviderKind` →
    `isRuntimeProviderName` + `loadProviderModuleByName`.
- `apps/hub/lib/boxes/types.ts` — `ProviderOption` gains `kind`, `credentials`, `bake`,
  `capabilities`, `sizes?`, `regions?`. All come from the sync snapshot, so they are **always**
  populated (no new opt-in flag; `?freshness=1` keeps its existing meaning).
- `apps/hub/app/(dashboard)/api/v1/providers/{credentials,prepare}/route.ts` — replace the
  closed `isProviderId()` list with `isRuntimeProviderName`.
- `apps/hub/app/(dashboard)/api/v1/lib/openapi.ts:2048` — `Provider.id` enum → open string;
  document the new fields. Fix the drifted `CreateBox` schema while here (missing `repoUrl`,
  `agentArgs`, `startAgent`, `foreground`, `opts`).

### Phase 3 — tray (`../agentbox-tray`)

- `Sources/AgentBox/Models/Project.swift` — `ProviderOption` Codable gains the new optional
  fields.
- `Menu/SettingsPanel.swift` — `providerMeta` credential fields come from
  `option.credentials.fields`; the SF-Symbol half stays local (a macOS detail a plugin should
  not own) with a `cube.fill` fallback. `PrepareProgressSteps` and `CreateBoxPanel
  .ProgressSteps` read `bake.bakeProgressSteps` / `bake.createProgressSteps`, hardcoded tables
  demoted to fallbacks. `bakeButton.isEnabled` (1000, 1123): `id == "docker"` →
  `!bake.required || hasCredentials`.
- `Menu/CreateBoxPanel.swift:587` — `provider != "docker"` stale-base gate → `bake.required`.
  The dropdown itself needs **no change**: it already renders whatever `/api/v1/providers`
  returns, so plugins appear once Phase 2 lands.
- `Menu/MenuBuilder.swift` — gate Pause on `capabilities.realPause` (today it renders for every
  running box). VNC/Web stay data-driven (`Box.hasVNC`) — already correct.
- Update `agentbox-tray/CLAUDE.md`'s `/providers` contract section.

### Phase 4 — retire the CLI name arrays

Each becomes a `resolveProviderDescriptor(name)?.capabilities.<flag>` lookup (sync, no module
load — that is the whole point of the Phase 1 snapshot):

| File | Array | Replacement |
|---|---|---|
| `apps/cli/src/commands/_open-in.ts:40` | `PERSISTENT_SSH_PROVIDERS` | `capabilities.persistentSsh` |
| `apps/cli/src/commands/_open-in.ts:54` | `IDE_PROVIDERS` | `capabilities.ssh \|\| directBoxSsh` |
| `apps/cli/src/commands/_open-in.ts:57` | `SSH_MOUNT_PROVIDERS` | same |
| `packages/sandbox-core/src/cloud-ssh.ts:153` | `PROVIDERS_WITH_DIRECT_BOX_SSH` | `capabilities.directBoxSsh` |
| `apps/cli/src/commands/prune.ts:81` | `CLOUD_PRUNE_PROVIDERS` | `capabilities.prune` |
| `apps/cli/src/commands/checkpoint.ts:42` | `KNOWN_PROVIDERS` | `capabilities.checkpoints` |
| `apps/cli/src/commands/checkpoint.ts:79` | `=== 'vercel' \|\| 'daytona'` | `capabilities.checkpointReboots` |
| `apps/cli/src/commands/fork.ts:18` | `FORK_PROVIDERS` | `getRuntimeProviderNames()` |
| `apps/cli/src/commands/install.ts:538` | `KNOWN_PROVIDERS` picker | `listProviderDescriptors()` |
| `apps/cli/src/wizard.ts:372` | `providerMeta().rebuildMinutes` | `descriptor.bake.approxMinutes` |
| `apps/cli/src/lib/cloud-sizing.ts:57` | per-name `if` chain | emit `location` when `descriptor.regions`, `inbound` when `capabilities.inbound`; the `timeoutMs`/`sandboxClass`/`networkPolicy` arms stay name-keyed (their config keys are built-in-only by design) |

Out of scope (deliberately): `perProviderConfigKey` still returns `''` for plugins — documented
behavior (`packages/config/src/image.ts:20`), plugins own their prepared-state.

### Phase 5 — docs + web UI

- `docs/provider-plugins.md` — the main doc deliverable, three new pieces:
  1. **"Declaring a descriptor"** — the full `ProviderDescriptor` shape, a worked example
     lifted from `examples/agentbox-provider-example`, and a field-by-field note on *which*
     fields are declared vs derived (with "don't declare what the module already proves").
  2. **"Migrating an existing plugin"** — explicitly: *you don't have to*. Then what you gain
     if you do, the fallback table from **Compatibility & migration** verbatim so an author can
     see exactly what they get by default, and the two-line change (`descriptor` export +
     `@madarco/agentbox-provider-sdk@^2.7`, then `agentbox plugin add <pkg>` to refresh the
     snapshot).
  3. **"Choosing capability values"** — the three that are easy to get wrong: `realPause`
     (does pause preserve state, or degrade to stop?), `persistentSsh` (does the per-box SSH
     identity outlive the CLI call? — Daytona's expiring token says no), and `checkpointReboots`.
  While here, fix the two stale facts (says "five built-in providers" — there are seven; says
  depend on SDK `^1` / `providerApiVersion: 1` — the SDK is `2.x`).
- `apps/web/content/docs/**` — mirror the descriptor contract on the public provider-plugins
  page; API reference for the `GET /api/v1/providers` response.
- `docs/cloud-providers.md` — one line pointing at the descriptor as the capability source.
- `apps/hub/app/(dashboard)/boxes/components/create-box-modal.tsx` — no change needed (already
  renders the fetched list); `settings/components/provider-actions.tsx:239`'s
  `p.id === 'docker'` → `!bake.required`.
- `CHANGELOG.md` — 1–2 sentences.

---

## Verification

`examples/agentbox-provider-example` is the E2E fixture (a working Vercel-backed provider clone
with `prepare`, `buildAttach` and an id-addressed `checkpoint`).

1. **Unit:** `pnpm test` + `pnpm typecheck` (tsup does not typecheck — CI will fail without it).
2. **Registration snapshot:**
   `cd examples/agentbox-provider-example && npm pack` → install → `agentbox plugin add …` →
   `jq '.plugins[].descriptors' ~/.agentbox/plugins.json` shows the merged declared+derived
   descriptor, with `checkpoints: true` (it overrides `checkpoint`) and `bakeable: true`.
3. **API:** rebuild + restart the hub — mandatory, it serves the standalone bundle:
   ```
   pnpm --filter @agentbox/hub build:standalone
   AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart
   curl -s -H "Authorization: Bearer $(cat ~/.agentbox/hub/token)" \
     'http://127.0.0.1:8787/api/v1/providers?freshness=1&hosts=expand' | jq '.data.providers[] | {id,kind,capabilities,credentials}'
   ```
   The example provider must appear with `configured: true` once baked, and every built-in row
   must carry the same field set as before plus `capabilities`.
4. **Tray:** build + run `../agentbox-tray`; the example provider is in the create dropdown, its
   Settings row renders the API-supplied credential fields, and Pause is hidden for a provider
   with `realPause: false`.
5. **Create:** `agentbox create -y -n plug-smoke --provider <example>` in the background, then
   `tail -f ~/.agentbox/logs/create.log` until `box ... ready` — do not block on a long timeout.
   Then create the same box from the tray dropdown and confirm the job streams to completion.
6. **CLI arrays:** `agentbox open --targets --json` lists the example provider under the SSH
   apps it qualifies for; `agentbox checkpoint set-default --provider <example>` is accepted;
   `agentbox prune --provider <example> --dry-run` enumerates.
7. **Back-compat with a real un-migrated plugin** — the check that answers "does this break old
   providers?" against something other than a unit test. Register the example provider
   **without** a descriptor (or check out its pre-Phase-1 revision), then confirm:
   its row appears in `GET /api/v1/providers` with `capabilities.vnc/dind/realPause: true` and
   `bake.required` matching `!!provider.prepare`; the tray still offers Pause and an enabled
   bake button; `agentbox create --provider <example>` still succeeds. Then confirm the
   auto-backfill fired: `jq '.version, .plugins[].descriptors' ~/.agentbox/plugins.json` shows
   `2` and a populated snapshot after that first load.
8. **SDK republish gate:** `pnpm --filter @madarco/agentbox-provider-sdk pack:test`, then
   `cd packages/provider-sdk && npm publish` (manual, per `/release-notes`).
