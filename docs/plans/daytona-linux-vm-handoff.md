# Daytona `linux-vm` — handoff

**Branch:** `agentbox/fork-153553` (pushed) · **Status:** shipped and live-verified, with named gaps below
**Date:** 2026-07-12

> **Closed out 2026-07-13** on `feat/daytona-linux-vm` (cut from this branch's tip). All five
> "not verified" items below were run against live Daytona. Four were fine; **the auto-stop (#1) was
> inert** — the host relay's own polling resets Daytona's inactivity clock, so an idle box never
> lapsed and billed indefinitely. Fixing it uncovered three more bugs (container-class `pause` was
> broken outright; `shell -- cmd` never resumed a paused cloud box; the container fallback asked for
> a container in a VM-only region). Full write-up, with the measurements, in
> [`docs/daytona-backlog.md`](../daytona-backlog.md) → "Idle auto-stop was inert". The
> `.github/workflows/box-image.yml` path-filter gap noted below the fold is fixed too — and it was
> real: this branch *does* shift `bin.cjs`, so merging it would have published no image.

## What landed

Daytona boxes now default to Daytona's **`linux-vm`** sandbox class instead of `container`.

| | Before (`container`) | After (`linux-vm`, default) |
| --- | --- | --- |
| `agentbox pause` | archive → cold storage; nothing running survives | **CPU + memory frozen** — running processes and tmux survive `unpause` |
| Checkpoints | dead code (the endpoint 404'd) | working; **~2 s** capture |
| Base bake | ~7 min (Dockerfile build) | **~66 s** (boots the published GHCR box image) |
| Region | any (`us`, `eu`) | **`us-east-1` only** |

Default resources are **2 vCPU / 4 GB / 8 GB** — Daytona's `daytona-vm-medium` shape.

Five commits, oldest first:

| Commit | What |
| --- | --- |
| `9630464ba` | SDK migration: `@daytonaio/sdk@0.179` → the renamed `@daytona/sdk@0.196` |
| `51e4c4379` | Config keys + class/region/auto-stop plumbing |
| `63e3286da` | The `linux-vm` base bake |
| `074ea83e0` | Cold checkpoints, real VM pause, and the fixes live testing forced |
| `ab14a32f6` | Docs (`docs/cloud-providers.md`, `docs/daytona-backlog.md`, public Fumadocs) |

### New config

| Key | Default | Notes |
| --- | --- | --- |
| `box.daytonaClass` | `linux-vm` | `linux-vm` \| `container`. Changing it needs `prepare --force` (a snapshot's class is immutable). |
| `box.daytonaRegion` | *empty* | Derived from the class: `linux-vm` ⇒ `us-east-1`, `container` ⇒ account default. |
| `box.daytonaTimeoutMs` | `1500000` (25 min) | Daytona `autoStopInterval`. `0` disables. An **inactivity** window, not an absolute TTL. |
| `box.daytonaVmBaseImage` | *empty* | Escape hatch: bake the VM base from an explicit image. Needed by monorepo contributors (see below) and private mirrors. |

## The tradeoff to keep front of mind

**VM runners exist in `us-east-1` only.** `us` (the account default) and `eu` have zero. So the new default relocates every Daytona box to US-East. `box.daytonaClass: container` is the documented way out for EU residency or latency, and it preserves the old behavior exactly.

## Four Daytona quirks the implementation works around

None of these are in Daytona's docs; all were found by running against the live API. They are the reason the code looks the way it does — **don't "simplify" them away.**

1. **Volume mounts are silently ignored on VM.** `create({volumes})` is accepted and echoed back in the sandbox DTO, and the path never exists in the guest. The shared `agentbox-credentials` volume therefore doesn't work; VM boxes take the per-create upload path (`ensureAgentVolumesForCloud`'s `volumesUsable: false`), the same one Hetzner uses.
2. **The VM rootfs conversion strips setuid bits.** `sudo` lands as mode 0755 and cannot escalate; only `mount`/`umount`/`su` keep theirs. `create({user:'root'})` is *not* an escape — the sandbox then fails to start. The bake repairs it through the docker socket (`dockerd` runs at boot, `vscode` is in the `docker` group): `docker run --rm --privileged -v /:/host alpine … chmod 4755 /host/usr/bin/sudo`. The fix persists into the snapshot.
3. **Never reuse a snapshot name.** Recreating one under a recently-deleted name yields a snapshot that reports `active` but **cannot boot** ("Sandbox failed to start: internal error") — the delete is async and racing it corrupts the new snapshot. Every capture takes a fresh (nonce-suffixed) name; the bake reaps the snapshot it replaces *after* the new one is recorded, and a base that fails to boot is treated as poisoned and rebuilt once under a never-used name.
4. **A snapshot with no explicit `resources` gets 1 vCPU / 1 GiB / 3 GiB** — and the box image doesn't fit in 3 GiB, so the build dies mid-pull with a bare "internal error". Always pass resources.

Plus the structural one: **a VM snapshot can only be built from a prebuilt registry image, never a Dockerfile.** A declarative `Image` + `LINUX_VM` fails with `build snapshot: rpc error: code = Unauthenticated`. Hence the GHCR-image bake.

## Verified live (against real Daytona)

- SDK migration: `prune --dry-run` (exercises the rewritten async-iterator `list()`), plus a full container-class `create → shell → destroy` including a Dockerfile build.
- `prepare --provider daytona --force` → VM base snapshot `active` at 2/4/8, pinned into `box.imageDaytona`, throwaway bake sandbox reaped.
- `create` → `shell`: runs as `vscode`, **`sudo -n id -un` → `root`**, daytona CLAUDE.md overlay present, `~/.claude` seeded, `agentbox-ctl` on PATH, DinD runs `hello-world`.
- `pause` (6.5 s) → Daytona state is **`paused`, not `archived`** → `unpause` (6.6 s) → a `sleep 9999` came back **with the same PID**.
- `checkpoint create` (22 s): box comes back with `ctl` running (the reconnect works) → restore into a new box: sentinel intact, sudo intact, and it's **still a VM** (`pause` reports "VM frozen").
- `checkpoint rm`, `destroy`, orphan sweep — nothing left running on Daytona.
- `doctor` reports `base snapshot … (base: linux-vm)`.
- Full unit suite (27 packages), lint, and the Fumadocs site all build clean.

**The GHCR ref derivation is confirmed correct**: `computeDockerBaseSha()` produces `a8a5352f50d0b19b…`, byte-identical to `apps/cli/scripts/print-box-context-sha.mjs` (what CI tags with). So a released CLI resolves to a real published tag.

## Open items

### Not verified — worth doing before you lean on it

1. **`renewTimeout` / the 25-min auto-stop.** Never exercised. The wiring is there (`refreshActivity()`, picked up automatically by `packages/relay/src/cloud-keepalive.ts`), but nobody has watched a box idle out, nor confirmed that the host relay poller's own traffic doesn't already reset Daytona's inactivity clock. **If preview traffic counts as activity, boxes never lapse and this feature is inert** (and there's a latent cost bug today, pre-existing). One experiment settles it: create with `autoStopInterval: 3`, hammer the preview URL for 4 min without any SDK call, poll `sb.state` / `sb.lastActivityAt`.
2. **A real logged-in `claude -p` turn in a VM box.** I verified sudo, seeded config, and DinD — but "box is ready" has not meant "agent works" on this repo before (see the E2B history).
3. **In-box `agentbox-ctl git push` from a VM box.** The relay-env regression has recurred on other cloud providers; this path wasn't run.
4. **Container-class create after the class plumbing.** The container box I created was on Phase 1 code, before `sandboxClass` was threaded. The default is now `linux-vm`, so the container path is only reachable via config and wasn't re-tested end-to-end.
5. **The `--claude-install npm` → container fallback.** Code path not exercised.

### Known gaps / follow-ups

- **Hot checkpoints are blocked on the SDK.** `linux-vm` supports a filesystem **+ memory** snapshot of a *running* sandbox — no stop, no reboot, process state preserved. That's strictly better than the cold path (it's the true analogue of `docker commit`'s no-pause default). The REST layer supports it (`CreateSandboxSnapshot { name, includeMemory }`), but `@daytona/sdk@0.196.0`'s wrapper takes only `(name, timeout)` and **drops the third argument on the floor**. Fix: call `@daytona/api-client`'s `SandboxApi.createSandboxSnapshot` directly, or file upstream and wait. Tracked as `docs/daytona-backlog.md` §5.1.2.
- ~~**npm users can't get VMs.**~~ **Fixed** — `.github/workflows/box-image.yml` now matrixes over the install mode and publishes both variants under their own fingerprint tags, so an npm bake has an image to boot from. (It also stops npm-mode *docker* users from eating a local image build on every first create.)
- **Monorepo contributors can't bake a VM by default.** A local `pnpm build` regenerates `packages/ctl/dist/bin.cjs`, shifting the build-context sha off CI's, so no published tag matches and prepare falls back to a container. Working as designed; `box.daytonaVmBaseImage` is the escape hatch. (This is *why* that key exists.)
- **The checkpoint manifest doesn't carry `sandboxClass`.** Restoring a VM checkpoint while `box.daytonaClass` names the *other* class records the wrong class on the box. Mitigated — `pause()` tries the recorded class and falls back to the other — but the honest fix is to put the class in `CloudCheckpointManifest` (`packages/sandbox-cloud/src/checkpoint.ts`, schema bump).
- **`agentbox daytona resync` still boots `agentbox/box:dev`** (`cli.ts`), triggering a full container build just to write into a volume. Pre-existing latent bug; point it at `readPreparedDaytonaState()?.base?.imageRef`.

### Unrelated pre-existing bug found along the way

**`detectGitRepos` requires `.git` to be a directory** (`packages/sandbox-core/src/git-detect.ts` → `isGitDir` does `stat().isDirectory()`). Inside an AgentBox box, `/workspace/.git` is a worktree *pointer file*, so creating any cloud box **from inside a box** silently falls back to a tarball seed — the box gets the files but no git history, no branch, no push path. Affects daytona/hetzner/vercel/e2b identically; nothing to do with this change. Fix is one line (accept a `.git` file and resolve the gitdir), but it deserves its own PR and its own test.
