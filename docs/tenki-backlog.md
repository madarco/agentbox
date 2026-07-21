# Tenki provider — build-out status

The `tenki` provider (`--provider tenki`) runs each box in a [Tenki](https://tenki.cloud)
sandbox — a Firecracker microVM — driven over the official TypeScript SDK
[`@tenkicloud/sandbox`](https://www.npmjs.com/package/@tenkicloud/sandbox).

It was added by mirroring the existing cloud providers (closest analog: **e2b**,
which is also a Dockerfile-derived microVM with SDK-only comms + pause/resume).
The full package builds, typechecks, lints, and unit-tests clean in the
workspace. **The end-to-end path has not yet been verified against a live Tenki
workspace** — no `TENKI_AUTH_TOKEN` was available when it was written — so the
items under "Live-verify" below are the gating work before relying on it.

## How the SDK maps onto `CloudBackend`

`@tenkicloud/sandbox` exposes a high-level `TenkiSandbox` (control plane) + a
`Session` handle (control + per-session data plane). The mapping:

| `CloudBackend` | Tenki SDK |
| --- | --- |
| `provision` | `client.createAndWait({ name, image \| snapshotId, env, cpuCores, memoryMb, diskSizeGb, allowInbound, allowOutbound, maxDurationMs, metadata, tags })` → store `session.id` as `sandboxId` |
| `get` / `state` | `client.get(id)` → map `session.state` (`RUNNING`/`PAUSED`/…) to `CloudState` |
| `list` | `client.list()` filtered to `metadata.agentbox === 'true'` |
| `start` / `resume` | `session.resume()` |
| `stop` / `pause` | `session.pause()` (pause is the cold-store; no separate stop in the high-level SDK) |
| `destroy` | `session.close()` (terminate) |
| `exec` | `session.run(['bash','-c', cmd], { cwd, env, privileged })` → `{ exitCode, stdout, stderr }` |
| `uploadFile` / `downloadFile` | `session.writeFileStream` / `readFileStream` (streamed, so a ~20 MB workspace tarball never sits fully in memory) |
| `listFiles` | `session.list(dir)` |
| `previewUrl` / `signedPreviewUrl` | `session.exposePort(port, { slug, ttlMs })` → public HTTPS `previewUrl`; reused via `listExposedPorts` |
| `refreshPreviewUrl` | `unexposePort` + `exposePort` |
| `renewTimeout` | `session.extend(target - current)` (additive, like vercel) |
| `snapshotExists` | `client.getSnapshot(id).state === 'READY'` |
| checkpoint (in `index.ts`) | `client.createSnapshotAndWait(sessionId, { name })` → id-addressed snapshot; `deleteSnapshot(id)` |
| attach (`buildTenkiAttach`) | host PTY ↔ `session.ssh()` bridge (`attach-helper.cjs`) |

Auth: `TENKI_AUTH_TOKEN` (workspace token, `tk_…`), with optional
`TENKI_BASE_URL` / `TENKI_GATEWAY_ADDRESS` control-plane overrides. Per-provider
config keys: `box.imageTenki`, `box.sizeTenki`, `box.defaultCheckpointTenki`.

## Done

- `packages/sandbox-tenki` package: `backend.ts`, `index.ts` (provider composition
  + checkpoint + attach overrides), `sdk.ts`, `retry.ts` (`withTenkiRetry` with
  ConnectRPC-code + socket-code classification), `credentials.ts`, `env-loader.ts`,
  `prepared-state.ts`, `prepare.ts`, `cli.ts`, `build-attach.ts`, `attach-helper.ts`.
- Unit tests: state mapping, preview-slug derivation, name sanitisation, retry
  classification, env parsing (`pnpm --filter @agentbox/sandbox-tenki test`).
- CLI wiring: provider registry, cloud-backend map, `tenki` subcommand + `--provider
  tenki` sugar, install wizard, doctor checks, prepare status, prune, checkpoint,
  fork, dashboard keep-alive.
- Config keys + `ProviderKind` / `PreparedProviderKind` unions.
- Docs: [`tenki.mdx`](../apps/web/content/docs/tenki.mdx) + sidebar + cross-links.

## Live-verify checklist (gating)

Run with a real `TENKI_AUTH_TOKEN` set, against a workspace with credits:

1. **`agentbox prepare --provider tenki`** — confirm the template build from the
   GHCR `agentbox/box` parent image works, OR that a pre-published
   `box.imageTenki` ref validates. This is the least-certain path: it assumes
   `createTemplate({ parentImage })` accepts an external OCI ref. If Tenki can't
   pull external images, switch prepare to the "boot a base session → run the
   agentbox install → snapshot → publishRegistryImage" flow (daytona's shape).
2. **`agentbox create --provider tenki`** — workspace seed (clone + stash +
   untracked tar) extracts into `/workspace`; the box user the SDK's `run` /
   file ops execute as matches the image's user (the backend assumes no chown is
   needed because `writeFile` and `run` share the data-plane uid — verify).
3. **`agentbox tenki claude`** — interactive attach over `session.ssh()`: raw-mode
   stdio bridge, tmux session, detach (`Ctrl+a d`). The SSH channel exposes no
   resize hook, so window-size propagation is absent — confirm tmux is usable.
4. **Preview URLs** — `agentbox url` resolves `session.exposePort(8080)`; the host
   `CloudBoxPoller` reaches the in-box relay over the exposed bridge port (8788).
5. **Checkpoints** — `agentbox checkpoint create` → `createSnapshotAndWait`;
   `create --checkpoint` boots from the snapshot id.
6. **Pause/resume + keepalive** — `agentbox pause`/`start`; confirm `session.extend`
   pushes the deadline while an agent is active.
7. **Comms through the agent proxy** — the SDK uses ConnectRPC + a `ws` data
   plane. A policy-enforcing egress proxy that blocks websocket upgrades / HTTP/2
   would break the data plane; verify on the user's host network (not the CI proxy).

## Deferred

- **In-box Docker (DinD)** — `launchDockerd: false` for now. Tenki microVMs may or
  may not grant the namespaces a container runtime needs (e2b does; the original
  vercel assumption was that it didn't). Verify, then flip to `true` and bake the
  engine into the prepared image if supported.
- **Attach window resize** — needs an SDK resize primitive on the SSH channel.
- **Volumes / agent-credential volume** — `ensureVolume` is not implemented, so
  agent credentials are seeded per-box (the e2b/vercel/hetzner model) rather than
  via a shared volume. Fine, but a Tenki volume could cache them.
- **`box.tenkiTimeoutMs` config key** — the session lifetime is currently a
  constant in `lib/cloud-sizing.ts` (45 min); promote to a config key if users
  need to tune it (mirrors `box.e2bTimeoutMs`).
