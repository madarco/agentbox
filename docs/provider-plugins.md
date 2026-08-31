# Provider plugins — external / community providers

AgentBox ships seven built-in providers (`docker`, `remote-docker`, `hetzner`,
`digitalocean`, `daytona`, `vercel`, `e2b`),
but the provider surface is open: anyone can publish a **provider plugin** as its
own npm package and users can add it with `agentbox plugin add` — no changes to
AgentBox itself. This doc is the authoring + operating guide. The user-facing
version lives on the docs site at [`/docs/build-a-provider`](https://agent-box.sh/docs/build-a-provider).
Two reference packages live under [`examples/`](../examples):

- [`agentbox-provider-sample`](../examples/agentbox-provider-sample) — a **stub**
  backend that throws on `provision`. The smallest thing that plugs in; read it
  first to see the contract.
- [`agentbox-provider-example`](../examples/agentbox-provider-example) — a **real,
  working** provider (Vercel-backed): a faithful copy of the built-in Vercel
  provider, repackaged as a plugin built only on `@madarco/agentbox-provider-sdk`. It
  exercises the *whole* surface — `prepare` (base-snapshot bake), `buildAttach`
  (no-SSH PTY bridge), an id-addressed `checkpoint` override, the box-runtime
  asset split, and prepared-state. Copy this when building a real cloud provider.

## How it works

- **`@madarco/agentbox-provider-sdk`** is the single public dependency a plugin needs. It
  re-exports the whole provider-facing surface (`Provider`, `CloudBackend`,
  `ProviderModule`, `createCloudProvider`, doctor + prepared-state helpers,
  `resolveSharedRuntimeAsset`, …) with the private internal packages inlined, so a
  plugin never touches AgentBox internals. It carries a `SDK_API_VERSION` that
  gates compatibility.
- The published `@madarco/agentbox` CLI bundles the seven built-ins. A plugin is
  **not** bundled — the user installs it, then `agentbox plugin add <pkg>` records
  it in `~/.agentbox/plugins.json`, and the CLI + host relay load it at runtime via
  a plain `import()` of the recorded entry (the extension seam).
- A plugin needs **zero** edits to AgentBox: `ProviderName` is an open string, the
  provider registry/doctor/config all consult the runtime set, and per-provider
  config falls back to the generic keys (a plugin manages its own base image via
  its prepared-state).

## What a provider plugin must ship

A package named `agentbox-provider-<name>` (or `@scope/agentbox-provider-<name>`)
that:

1. Depends on `@madarco/agentbox-provider-sdk` (`^2`).
2. Declares its contract version in `package.json`:
   ```json
   { "agentbox": { "providerApiVersion": 3 } }
   ```
3. Exports a **`providerModule`** (or `providerModules` for a multi-provider
   package) — the uniform surface AgentBox loads it through:
   ```ts
   import { createCloudProvider, type CloudBackend, type ProviderModule } from '@madarco/agentbox-provider-sdk';

   const backend: CloudBackend = {
     name: 'myprovider',
     async provision(req) { /* create the VM/sandbox, return { sandboxId } */ },
     async get(id) { /* … */ },
     async start(h) {}, async stop(h) {}, async pause(h) {}, async resume(h) {},
     async destroy(h) {}, async state(h) { return 'running'; },
     async exec(h, cmd, opts) { /* … */ },
     async uploadFile(h, local, remote) {}, async downloadFile(h, remote, local) {},
     async listFiles(h, dir) { return []; },
     async previewUrl(h, port) { return { url: `https://…:${port}` }; },
     // optional: createSnapshot/deleteSnapshot (checkpoints), list (prune),
     // refreshPreviewUrl, signedPreviewUrl, attachArgv, renewTimeout, …
     // If `exec` defaults to an UNPRIVILEGED user, set `stageFilesAsRoot: true`
     // — see "The box user" below.
   };

   const provider = createCloudProvider(backend, { defaultResources: { cpu: 2, memory: 4, disk: 40 } });

   export const providerModule: ProviderModule = {
     provider,
     backend,
     ensureCredentials: async () => { /* first-run login; persist a token */ },
     readCredStatus: () => ({ configured: true }),
     currentBaseFingerprintLive: async () => undefined,
     doctorChecks: async () => [{ label: 'credentials', status: 'ok', detail: 'configured' }],
   };
   ```
   Only `provider` and `doctorChecks` are required. `createCloudProvider` supplies
   the entire lifecycle (workspace seeding, ctl launch, relay wiring, preview URLs,
   checkpoints, cp) on top of the thin ~13-method `CloudBackend` — "a cloud is one
   file."

## Declaring a descriptor

A **`ProviderDescriptor`** is how your provider tells AgentBox's UIs what it is
and what it can do — a real label in the tray/web create pickers, the right
credential form, and correct capability gating. Built-in providers declare the
same shape in `@agentbox/config`'s `PROVIDERS` table; you declare it on your
`providerModule`:

```ts
import type { ProviderDescriptor } from '@madarco/agentbox-provider-sdk';

const descriptor: ProviderDescriptor = {
  name: 'myprovider',
  kind: 'cloud',                       // 'local' = a docker-style local engine
  label: 'MyProvider (cloud microVM)',
  loginHint: 'paste an API token from the MyProvider console',
  credentials: {
    // secrets.env key NAMES that mean "configured". Only names are ever read.
    envKeys: ['MYPROVIDER_TOKEN'],
    // The form a UI renders. Each `key` is passed verbatim to setCredentials.
    fields: [
      { key: 'token', label: 'API token' },
      { key: 'region', label: 'Region', optional: true, secret: false },
    ],
  },
  bake: {
    required: true,                    // false if your base self-heals on create
    approxMinutes: '5-10',
    createProgressSteps: 40,           // typical streamed log lines, for pacing
    bakeProgressSteps: 500,
  },
  capabilities: {
    checkpoints: true, checkpointReboots: false,
    ssh: false, persistentSsh: false, directBoxSsh: false,
    inbound: false, directGit: true, resync: true, prune: true,
    vnc: true, dind: true,
    pauseSemantics: 'freeze',
    hubRoutable: true,
  },
  blurb: 'MyProvider microVMs',
  sizeDesc: 'Per-provider override of `box.size` for myprovider (vCPU count).',
  imageDesc: 'Per-provider override of `box.image` for myprovider (snapshot id).',
};

export const providerModule: ProviderModule = { provider, backend, descriptor, /* … */ };
```

`agentbox plugin add` snapshots this into `~/.agentbox/plugins.json`, so every
consumer — the CLI's sync `open --targets` probe, the hub's hot `listProviders`
path, the tray — resolves it without importing your package.

**Declare what code can't reveal; don't mirror method presence.** AgentBox
deliberately does *not* infer capabilities from your `Provider` object, because
`createCloudProvider` defines `checkpoint`, `setInbound`, `repairReachability`
and `enableDirectGit` on *every* cloud provider — their presence says which
scaffold you used, not what you support. (The built-in docker provider is the
sharp end of this: it has working `docker commit` checkpoints and no
`provider.checkpoint` at all.)

Three values ARE cross-checked against your `CloudBackend`, which you wrote and
which therefore means something — declare them to match or a test will disagree:

| Descriptor field | Must equal |
|---|---|
| `capabilities.prune` | `!!backend.list` |
| `capabilities.inbound` | `!!backend.setInbound` |
| `capabilities.timeoutModel` | `backend.timeoutModel` |

## Choosing capability values

Most fields are obvious. These three are the ones people get wrong:

- **`pauseSemantics`** — what `pause` *actually* does. `'freeze'` preserves the
  running process tree (a real pause/resume or snapshot-resume). `'stop'` powers
  the box off so only the disk survives — that's what hetzner and digitalocean
  do (`pause ≡ stop` in both backends). This is **not** a gate on showing a pause
  control: powering a VPS down is useful, it stops the billing. A UI should
  relabel on `'stop'`, never hide.
- **`persistentSsh`** — whether the per-box SSH identity outlives the CLI call.
  An app like Codex connects again on its own later, so a gateway handing out an
  expiring token (Daytona's 60-minute credential) does **not** qualify even
  though SSH works right now. A per-box key file on disk does.
- **`checkpointReboots`** — whether capturing a checkpoint stops and restarts the
  box. If your snapshot API requires a stopped sandbox, this is `true` and the
  CLI will confirm before yanking a live agent.

`ssh` means a real sshd you can `agentbox code` (IDE) and `agentbox open`
(sshfs-mount) into. `directBoxSsh` is narrower: your `buildAttach` yields a plain
`ssh … user@host` pointing AT the box, the one shape AgentBox can parse a target
out of — leave it false if you implement `sshTarget` yourself.

## Migrating an existing plugin

**You don't have to.** `descriptor` is optional and `SDK_API_VERSION` did not
change, so a plugin built against an older SDK loads exactly as before. When one
is missing, AgentBox derives what it can from your module and fills the rest with
defaults chosen to reproduce pre-descriptor behavior:

| Field | Without a descriptor | Why |
|---|---|---|
| `label` | your provider name | what UIs showed before |
| `kind` | `'cloud'` if you export a `backend` | derived |
| `bake.required` | **`false`** | a `true` default would newly BLOCK creates that work today |
| `credentials.fields` | one `apiKey` field if you export `setCredentials`, else none | matches the old tray fallback |
| `capabilities.vnc` / `dind` | **`true`** | the scaffold wires both; `false` would delete working UI |
| `capabilities.pauseSemantics` | `'freeze'` | UIs showed an unqualified pause |
| `capabilities.checkpoints` / `ssh` | `!!provider.checkpoint` / `!!provider.sshTarget` | sound for a scaffold-based plugin |
| `capabilities.prune` / `inbound` / `timeoutModel` | from your `CloudBackend` | authored by you, so honest |
| `persistentSsh` / `directBoxSsh` / `inbound` | `false` | plugins were excluded from those paths before; opt in by declaring |

So an un-migrated plugin **gains** the create dropdown, a credential form, and
`prune` / `checkpoint` / `fork` eligibility, and loses nothing. AgentBox
back-fills the derived descriptor into `plugins.json` the first time it loads
your module, so this happens with no user action.

Migrating is two lines: bump to `@madarco/agentbox-provider-sdk@^2.8`, export a
`descriptor`, then `agentbox plugin add <pkg>` to refresh the snapshot.

One thing a plugin still doesn't get: a `box.image<P>` / `box.size<P>` /
`box.defaultCheckpoint<P>` config key. Those are statically typed per built-in.
Your provider falls back to the generic `box.image` / `box.size`, and
`checkpoint set-default --provider <you>` warns that it is writing the
cross-provider default. Own your base via your own prepared-state file instead
(see "Prepare, attach, and checkpoints" below).

## The box user

Everything AgentBox puts in a box belongs to **`vscode`** with `$HOME` at
`/home/vscode`: the seeded agent credentials (`~/.agentbox-creds/*`, symlinked to
the paths each agent reads), the agent static config, `/workspace`, and the ctl
daemon's tmux server. Two consequences for a plugin whose platform runs commands
as some *other* user by default:

- **`backend.exec` must hop to the box user** (`sudo -n -E -u vscode -H …` or the
  platform's own user switch), and so must **`buildAttach`**. An attach that
  lands in a different `$HOME` finds no credentials — the agent starts and asks
  the user to log in — and cannot see the supervisor's tmux sessions at all.
- **Set `stageFilesAsRoot: true` on the backend** when that exec user is
  unprivileged. The `carry:` extract untars with `--no-same-owner` (so the files
  land owned by whoever ran the extract) and then hands them to the box user;
  only root can do that, so without the flag every carry entry fails with
  `chown: Operation not permitted`. Ownership stays correct under root because
  the chown resolves the owner from `--reference=/home/vscode`, never a
  hardcoded uid — the box user's uid differs per platform (1000 on
  docker/hetzner, 1001 on vercel, 1002 on e2b, whatever `useradd` picked on
  yours), so never hardcode one yourself either.

If your base image ships the coding agents under a different user's home, make
them reachable on the box user's `PATH` — an agent AgentBox can't exec is an
agent the box can't run.

## Box-side runtime (VPS-style providers)

A provider that bakes a base image by installing files onto a throwaway host (like
hetzner/digitalocean) needs the provider-neutral box runtime — `ctl.cjs` and the
shims. Do **not** vendor your own; pull them from the running CLI so they stay
version-locked to it:

```ts
import { resolveSharedRuntimeAsset } from '@madarco/agentbox-provider-sdk';
const ctl = resolveSharedRuntimeAsset('ctl.cjs'); // absolute host path; scp it to the box
```

Ship only your provider-specific pieces (an `install-box.sh`, a
`custom-system-CLAUDE.md`). Providers that build from a Dockerfile don't need any
of this. The `agentbox-provider-example` package is the worked example: its
`runtime-assets.ts` resolves the shared runtime via `resolveSharedRuntimeAsset`
and vendors only `scripts/provision.sh` + `scripts/custom-system-CLAUDE.md`.

## Prepare, attach, and checkpoints (cloud providers)

A cloud provider that bakes its base image (no Dockerfile) typically overrides
three optional capabilities on top of `createCloudProvider`. The SDK re-exports
the helpers each needs, so it's all buildable on `@madarco/agentbox-provider-sdk` alone:

- **`prepare`** — boot a builder sandbox, run your installer, snapshot it. Bake
  the host's static agent config into the snapshot with
  `stageAllAgentStatic` — one entry per agent the host actually has, plus the
  shared `~/.agents` tree, each carrying the `extractDir` to unpack it at. (v3
  replaced the three per-agent stagers: naming them meant a provider baked
  exactly three agents forever.) Persist the result in your own
  `~/.agentbox/<name>-prepared.json` via `read/writePreparedStateRaw` +
  `preparedStatePathFor` (these accept a plugin's open-string provider name).
- **`buildAttach`** — for a provider with no SSH, render the shared inner tmux
  command with `renderInnerCommand` + `hostTermForCloud` and return your own
  transport's argv.
- **`checkpoint`** — if your cloud's snapshots are **id-addressed** (an opaque id
  you can't name, like Vercel/E2B), the scaffold's default (which drives
  `backend.createSnapshot(handle, name)`) doesn't fit. Override the whole
  capability and store the snapshot *id* in the manifest with
  `writeCloudCheckpointManifest` / `listCloudCheckpoints` /
  `resolveCloudCheckpoint` / `removeCloudCheckpointDir` /
  `currentCloudBaseFingerprint`. If your snapshots are name-addressed, just
  implement `backend.createSnapshot`/`deleteSnapshot` and skip the override.

## Per-agent variants (optional)

A box is created **for an agent set** (`agentbox claude --provider yours`), and
the built-in providers bake one artifact per set on top of an agentless base:
`agentbox prepare --provider yours --agents claude` boots the base, runs just
that agent's install recipe, and re-snapshots. A matching box then starts with
the agent already present instead of installing it at create.

**This is opt-in and costs nothing to skip.** `agents` is optional on both
`PrepareOptions` and `CloudProvisionRequest`, so a provider that ignores it keeps
working exactly as before — it always boots its base, and `ensureAgentInstalled`
puts the agent in at create. That is why supporting variants needs **no
`SDK_API_VERSION` bump**.

To opt in:

```ts
import {
  agentSetArg, normalizeAgentSet, variantFingerprint,
  resolveAgentSpec, resolveAgentInstall, renderInstallRecipe, renderPackageInstall,
} from '@madarco/agentbox-provider-sdk';

// 1. Identity for this bake. '' is the agentless base; the set is normalised,
//    so ['codex','claude'] and ['claude','codex'] are the SAME artifact.
const agents = normalizeAgentSet(opts.agents);
const variantKey = agentSetArg(agents);

// 2. Fingerprint. Use this instead of `claudeInstallFingerprint` — it folds the
//    agent set in, and is the IDENTITY for the empty set, so an existing base
//    record keeps its hash and does not spuriously re-bake.
const contextSha = variantFingerprint(baseSha, { claudeInstall, agents });

// 3. Render the install into your bake. Same data the built-ins and the runtime
//    installer use, so a baked agent and a runtime-added one are identical.
for (const id of agents) {
  const spec = resolveAgentSpec(id);
  const install = resolveAgentInstall(spec.install, claudeInstall);
  const steps: string[] = [];
  if (install.packages?.length) {
    const line = renderPackageInstall(install.packages);
    // An OPTIONAL prerequisite must not fail the bake.
    steps.push(install.packagesOptional ? `{ ${line} } || true` : line);
  }
  // `runAs: 'box-user'` is load-bearing: native installers write to the INVOKING
  // user's ~/.local/bin, so running them as root hides the binary in /root.
  const recipe = renderInstallRecipe(install.recipe);
  steps.push(install.runAs === 'box-user' ? `sudo -u vscode -H bash -lc '${recipe}'` : recipe);
  if (install.postInstall) steps.push(install.postInstall);
  // Verify on the BOX USER's PATH, not just that the build exited 0.
  steps.push(`sudo -u vscode -H bash -lc 'command -v ${spec.binary} >/dev/null'`);
}
```

`renderPackageInstall` dispatches on the package manager the box actually has
(`apt-get` | `dnf` | `microdnf`) instead of assuming Debian — Vercel's sandboxes
are Amazon Linux, where a hardcoded `apt-get` exits 127.

Three rules the built-in providers each learned the hard way:

- **Always fall back to the base.** After a base-only `prepare` — the documented
  first-run flow — no variant exists yet. Resolving must return the base, not
  throw, or *every* create fails for a new user.
- **Never pin a variant** into `box.image<Provider>` or a shared custody record.
  Those are single-slot: a variant written there makes every box on your provider
  boot one agent's artifact.
- **Keep your `base` record meaning the agentless base.** Provider-generic readers
  (freshness, bake sharing) read `base.contextSha256` and assume exactly that;
  pointing it at the newest bake reports a permanent false "stale".

---

## Credentials & config

- Persist your API token however you like; the convention is a 0600
  `~/.agentbox/secrets.env` entry read on demand (see the built-in providers'
  `env-loader.ts`/`credentials.ts`).
- `agentbox create --provider <name> [--image/--size/--checkpoint …]` — the CLI
  flags override per-create. For a persistent base image, write it into your own
  `~/.agentbox/<name>-prepared.json` from your `provider.prepare()` and read it back
  in the backend when it sees the image sentinel (`agentbox/box:dev`). AgentBox does
  **not** pin a plugin's image into its own config.

## Certify the backend

Copy the cloud-backend contract suite
(`packages/sandbox-cloud/test/mock-backend-contract.test.ts` +
`makeMockCloudBackend`), swap in your backend, and ensure every test passes.

## Operating a plugin (users)

```
npm i -g agentbox-provider-myprovider     # or install anywhere resolvable
agentbox plugin add agentbox-provider-myprovider   # validates + records it (a path also works)
agentbox plugin list
agentbox doctor                            # shows your provider's group
agentbox create --provider myprovider      # first create triggers ensureCredentials
agentbox plugin remove myprovider          # unregister (does not uninstall the npm package)
```

Every create goes through the hub's `POST /api/v1/boxes` (see
[`hub-api-single-path-plan.md`](./hub-api-single-path-plan.md)), so the hub
resolves plugin providers off the same `~/.agentbox/plugins.json` registry the
CLI reads — including the local hub a plain `agentbox create` talks to. A plugin
registered while the hub is running is picked up on the next request; no hub
restart. The hub applies no prepared-state gate to a plugin provider (plugins own
their own setup story, and a `prepare` step is optional for them).

## Trust

A provider plugin runs **in-process** with full host + credential access — it is
trusted code, exactly like the CLI. `agentbox plugin add` is the consent boundary:
it names the package + version and warns before recording. Only add plugins you
trust. AgentBox does not sandbox plugin code (a provider legitimately needs to
provision infrastructure and handle secrets).

## Compatibility

The CLI loads a plugin only if its `providerApiVersion` is in the CLI's supported
set (`SUPPORTED_SDK_API_VERSIONS`). An incompatible plugin is refused at
`plugin add` and skipped (with a warning) at load — it never crashes the CLI.

**A plugin pinned to an older SDK tolerates config keys added after it shipped.**
The SDK inlines `@agentbox/config`, so your plugin carries a snapshot of the key
registry taken when you built it — and users run it against a CLI that keeps
adding keys. An unknown key is therefore **skipped with a warning, never an
error**: the config layer it appears in still loads, and `create` proceeds. (The
host CLI is the one that tells the user; a plugin's copy stays silent, because it
registers no warning sink.) You don't need to republish every time AgentBox adds
a config key. Wrong *types*, renamed keys, and `agentbox config set <bad-key>`
still fail loud — the registry is authoritative for keys it does know.

The same rule holds in-box for `agentbox.yaml`: `agentbox-ctl` (baked into an
image that may be months old) skips keys it doesn't recognize rather than
refusing to boot.

## Publishing the SDK (maintainers)

The SDK ships to npm as **`@madarco/agentbox-provider-sdk`** (source at
`packages/provider-sdk`). It's a self-contained bundle — tsup inlines the internal
`@agentbox/*` packages (`noExternal`), so the only runtime deps a consumer pulls
are `execa` + `yaml`. Publish it **in lockstep** with a CLI release whose
`SUPPORTED_SDK_API_VERSIONS` includes the SDK's `SDK_API_VERSION`; additive
surface changes are a minor bump, a breaking `Provider`/`CloudBackend`/
`ProviderModule` change is a major bump **and** an `SDK_API_VERSION` bump.

```bash
# 1. Prove the *published artifact* is complete (packs, installs the tarball in a
#    throwaway dir, asserts every export the example depends on — a file:/workspace
#    link can't catch a missing file or an export that didn't ship).
pnpm --filter @madarco/agentbox-provider-sdk pack:test

# 2. Publish (manual — needs the npm token). prepublishOnly rebuilds dist;
#    publishConfig.access=public handles the scoped-package default.
cd packages/provider-sdk && npm publish
```
