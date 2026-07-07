# Provider plugins — external / community providers

AgentBox ships five built-in providers (docker, daytona, hetzner, vercel, e2b),
but the provider surface is open: anyone can publish a **provider plugin** as its
own npm package and users can add it with `agentbox plugin add` — no changes to
AgentBox itself. This doc is the authoring + operating guide. Two reference
packages live under [`examples/`](../examples):

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
- The published `@madarco/agentbox` CLI bundles the five built-ins. A plugin is
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

1. Depends on `@madarco/agentbox-provider-sdk` (`^1`).
2. Declares its contract version in `package.json`:
   ```json
   { "agentbox": { "providerApiVersion": 1 } }
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
  `stageClaudeStaticForUpload` / `stageCodexStaticForUpload` /
  `stageOpencodeStaticForUpload`. Persist the result in your own
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
