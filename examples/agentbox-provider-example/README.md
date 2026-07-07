# agentbox-provider-example

A **real, working** AgentBox provider plugin, built only on
[`@madarco/agentbox-provider-sdk`](../../packages/provider-sdk). It is a faithful copy of
the built-in **Vercel** provider, repackaged as an external plugin — genuinely
provisions Firecracker microVMs, bakes a base snapshot, attaches an interactive
terminal, and takes checkpoints. Its job is to (a) prove the whole plugin surface
end-to-end and (b) be the canonical copy-me reference.

This is an **internal test / example — not published.** The provider name is
`example` (generic on purpose): it demonstrates *how to build a plugin*, and the
Vercel backend just happens to be what it drives.

## sample vs example

- [`agentbox-provider-sample`](../agentbox-provider-sample) — a **stub** backend
  that throws on `provision`. The smallest thing that plugs in; shows the contract.
- **`agentbox-provider-example`** (this one) — a **real** cloud provider. Shows the
  full surface: `CloudBackend` over a cloud SDK, `prepare` (base-snapshot bake),
  `buildAttach` (no-SSH PTY bridge), an id-addressed `checkpoint` override, doctor
  checks, prepared-state, and the box-runtime asset model.

## What it exercises in the SDK

- `createCloudProvider` + the full `CloudBackend` (~13 methods) over `@vercel/sandbox`.
- **Box-runtime split** (`runtime-assets.ts`): shared runtime (`ctl.cjs` + shims)
  is pulled from the running CLI via `resolveSharedRuntimeAsset` (never vendored);
  only the provider-specific `scripts/provision.sh` + `custom-system-CLAUDE.md`
  are vendored in this package.
- **Prepared-state** it manages itself (`~/.agentbox/example-prepared.json`) — the
  CLI does not pin a plugin's base image into its own config.
- **Attach** helpers (`renderInnerCommand`, `hostTermForCloud`) and **prepare-time
  agent-config staging** (`stageClaudeStaticForUpload`, …).
- **Checkpoint authoring** (`writeCloudCheckpointManifest`, `listCloudCheckpoints`,
  `resolveCloudCheckpoint`, `removeCloudCheckpointDir`, `currentCloudBaseFingerprint`)
  — needed because Vercel snapshots are id-addressed.

## Credentials

The example **reuses the built-in Vercel provider's credentials** — the same
`~/.agentbox/secrets.env` keys and Vercel CLI store written by `agentbox vercel
login`. There is no separate login here; run `agentbox vercel login` once and this
plugin picks it up. (A standalone third-party plugin would ship its own
`ensureCredentials`.)

## Try it

```bash
# Build the local SDK first (this package depends on it via a file: link):
pnpm --filter @madarco/agentbox-provider-sdk build

# Build the plugin:
npm install
npm run build

# Register it with your AgentBox CLI:
agentbox plugin add .
agentbox plugin list
agentbox doctor                       # shows an `example:` group

# Bake the base snapshot (one-time; ~5-10 min), then create a box:
agentbox prepare --provider example
agentbox create --provider example -n smoke
agentbox checkpoint create            # exercises the id-addressed checkpoint override

# Clean up:
agentbox destroy smoke -y
agentbox plugin remove example
```

See [`docs/provider-plugins.md`](../../docs/provider-plugins.md) for the full
authoring guide.
