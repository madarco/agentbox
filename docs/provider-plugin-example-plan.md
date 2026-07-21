# Provider plugin example (Vercel-backed) — design + SDK findings

## Why

The plugin system (`@madarco/agentbox-provider-sdk` + `agentbox plugin add`) had only one
example: `examples/agentbox-provider-sample`, a **stub** backend that throws on
`provision`. It proves the wiring but exercises almost none of the real provider
surface. We added `examples/agentbox-provider-example` — a **real, working**
provider (a faithful copy of the built-in Vercel provider, repackaged as an
external plugin built only on `@madarco/agentbox-provider-sdk`) to:

1. Stress-test that the public SDK actually re-exports everything a real cloud
   provider needs (it did not — see findings below).
2. Be the canonical copy-me reference for authors building a real provider.

It is **not published** — it lives under `examples/`, is an internal test, and
reuses the built-in Vercel provider's credentials (`agentbox vercel login`).

## What was built

- **Provider name** `example`, package `agentbox-provider-example`, prepared-state
  at `~/.agentbox/example-prepared.json`. Depends on the local SDK via
  `"@madarco/agentbox-provider-sdk": "file:../../packages/provider-sdk"` (npm symlinks it,
  so a rebuilt SDK is picked up without reinstall) and `@vercel/sandbox` from npm.
- **Ported from `packages/sandbox-vercel/src`**, rewriting every `@agentbox/core`
  / `sandbox-cloud` / `sandbox-core` import to `@madarco/agentbox-provider-sdk` and
  renaming `vercel` → `example`: `backend.ts`, `sdk.ts`, `env-loader.ts`,
  `cli-store.ts`, `sbx-cli.ts` (trimmed), `retry.ts`, `prepared-state.ts`,
  `prepare.ts`, `runtime-assets.ts` (rewritten), `build-attach.ts`,
  `provider-module.ts`, `index.ts`.
- **Trimmed** (not needed for a plugin): `cli.ts` (plugins can't add top-level CLI
  commands), `vercel-rest.ts` (project/deployment REST), and the full interactive
  credential wizard (`credentials.ts` slimmed to reuse the built-in login).
- **Box-runtime split** (`runtime-assets.ts`, the key demonstration): shared
  runtime (`ctl.cjs` + shims) is pulled from the running CLI via
  `resolveSharedRuntimeAsset`; only `scripts/provision.sh` +
  `scripts/custom-system-CLAUDE.md` are vendored in the package.

## SDK gaps found + fixed (all additive, no `SDK_API_VERSION` bump)

The exercise surfaced that `@madarco/agentbox-provider-sdk` was missing the surface a
real cloud provider needs beyond the basic backend. Added to
`packages/provider-sdk/src/index.ts` (re-exported from `@agentbox/sandbox-cloud`):

- **Attach:** `hostTermForCloud`, `renderInnerCommand` (for a no-SSH `buildAttach`).
- **Prepare-time staging:** `stageClaudeStaticForUpload`,
  `stageCodexStaticForUpload`, `stageOpencodeStaticForUpload`, `StageResult`.
- **Checkpoint authoring (id-addressed snapshots):** `writeCloudCheckpointManifest`,
  `listCloudCheckpoints`, `resolveCloudCheckpoint`, `removeCloudCheckpointDir`,
  `currentCloudBaseFingerprint`.

Separately, in `packages/sandbox-core/src/prepared-state.ts`, the
`preparedStatePathFor` / `read/writePreparedStateRaw` helpers were typed to the
built-in `ProviderKind` union, which rejected a plugin's open-string provider
name. Widened `PreparedProviderKind` to `ProviderKind | (string & {})` (keeps
autocomplete for built-ins) and added a `[A-Za-z0-9._-]` guard on the name since
it lands in a filename.

## CLI gap found + fixed (plugin checkpoints were invisible)

`agentbox checkpoint list` / `rm` iterated only the hardcoded built-in
`CLOUD_PROVIDER_NAMES`, so a **plugin** provider's checkpoints never showed and
couldn't be removed. Added `listCloudBackendDirs()` to `@agentbox/sandbox-cloud`
(scans `~/.agentbox/cloud-checkpoints/` for backend dirs) and an `allCloudBackends()`
helper in `apps/cli/src/commands/checkpoint.ts` that unions the built-ins with the
on-disk dirs — used by `list`, `rm`, and the `set-default` existence check.
(`set-default --provider <plugin>` stays gated to built-ins; a plugin uses the
cross-provider `box.defaultCheckpoint` fallback.)

## Checkpoint design note

`createCloudProvider` supplies a **default** checkpoint that drives
`backend.createSnapshot(handle, name)` — correct for **name-addressed** snapshots.
Vercel/E2B snapshots are **id-addressed** (opaque id you can't name), so the
built-ins (and this example) **override** the whole `checkpoint` capability to
store the snapshot *id* in the manifest. That override is what needs the
cloud-checkpoint helpers above; before this change it couldn't be built on the SDK.

## Verify

```
pnpm --filter @madarco/agentbox-provider-sdk build          # after SDK edits
cd examples/agentbox-provider-example && npm install && npm run build
node ../../apps/cli/dist/index.js plugin add . -y
node ../../apps/cli/dist/index.js doctor            # shows an `example:` group
node ../../apps/cli/dist/index.js prepare --provider example
node ../../apps/cli/dist/index.js create --provider example -n smoke
#   … verify a real claude -p turn + attach + checkpoint create …
node ../../apps/cli/dist/index.js destroy smoke -y
node ../../apps/cli/dist/index.js plugin remove example
```
