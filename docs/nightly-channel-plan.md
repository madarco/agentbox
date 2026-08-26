# Nightly release channel — plan of record

Status: **implemented** 2026-07-25 — all five phases landed; the live pass (below) needs the first
real nightly publish.

## Why

Big features land on `nightly` and sit there. When this work started, `nightly` was **84 commits**
ahead of `main` (the whole `feat/control-box-plan` line) while `main` was still `release: v0.27.0`.
Running that code meant cloning the monorepo, so the only real-world testing it got was the
maintainer's.

The goal is a second, clearly-marked channel a friendly user opts into with one command and then
stays on, so features get exercised on other people's machines, projects, and cloud accounts before
they reach a stable release.

## What exists today (the starting point)

One channel, hardcoded in five places:

| what | where |
|---|---|
| npm dist-tag `latest` | `apps/cli/src/lib/update-check.ts`, `apps/cli/src/commands/update.ts` |
| tray release tag `tray-latest` | `apps/cli/src/commands/install-app.ts`, tray `Update/UpdateChecker.swift` |
| triplet-only semver compare | `apps/cli/src/lib/semver-lite.ts` |

Publishing is manual on both sides and stays that way (see Decisions): `npm publish --auth-type=web`
run by a human because npm's 2FA web-auth URL gets redacted in tool output, and the tray is signed +
notarized from the maintainer's keychain with no CI at all.

Consequence worth stating plainly: a prerelease build installed **today** gets no update nudges
(`compareSemver` returns `null` for anything that isn't `x.y.z`), and its first `agentbox self-update`
silently moves it **back to stable** (`@latest` is hardcoded).

## Decisions

- **Manual publishing, both sides.** No `NPM_TOKEN`, no npm trusted-publishing/OIDC, no macOS CI for
  the tray. The npm side rides the existing `/release-notes` skill via a new `nightly` argument.
- **Two channels only**: `stable` and `nightly`.
- **Nightly means "the newest build, prerelease or not"** — see below; this is the decision that
  shapes everything else.

## Design

| | stable | nightly |
|---|---|---|
| npm dist-tag | `latest` | `nightly` |
| npm version | `0.27.0` | `0.28.0-nightly.202607251430` |
| tray release tag | `tray-latest` | `tray-nightly` |
| tray version | `0.1.14` | `0.1.15-nightly.202607251430` |

### Nightly polls both tags and takes the greater

A nightly user checks **both** dist-tags and installs whichever version is higher. Because a nightly
is named for the release it *precedes*, semver gives the wanted priority for free —
`0.28.0 > 0.28.0-nightly.5` — so the moment `0.28.0` ships, every nightly tester is offered it
automatically, with no second publish under the `nightly` tag. They stay on it until
`0.29.0-nightly.1` appears and outranks it again.

Stable users are unaffected: they only ever look at `latest`, and pay exactly one probe per component
as before.

### Channel membership is sticky once joined

Deriving the channel from the running version (`-nightly.` suffix ⇒ nightly) is the **bootstrap** —
it is what makes `npm i -g @madarco/agentbox@nightly` self-sustaining with no config step.

But the rule above hands testers a *stable* build (`0.28.0`) with no suffix, which would derive
`stable` on the next launch and silently undo the opt-in. So the channel is persisted to
`update.channel` when it resolves to nightly, and whenever `self-update` crosses onto a
non-prerelease version. The key is `auto | stable | nightly` (default `auto`); `--channel` writes it
and `--channel stable` is the opt-out.

### Version scheme

`<next minor>-nightly.<YYYYMMDDHHmm UTC>` — unique and monotonic with no counter to track.

The base is the minor-bump of the **published `latest`** (`npm view @madarco/agentbox version`),
*not* of the branch's `package.json`. After a nightly commit the branch reads `0.28.0-nightly.5`,
whose minor-bump is `0.28.0` — which would **tie** the just-shipped stable instead of outranking it,
producing a nightly no tester ever receives. Anchoring on the published release is deterministic and
immune to that churn: the base is `0.28.0` until `0.28.0` ships, then `0.29.0`.

## Phases

All five implemented 2026-07-25 (branch `feat/nightly-channel`). What remains is the live pass below.

- [x] **Phase 0** — this doc.
- [x] **Phase 1** — CLI channel plumbing: `apps/cli/src/lib/channel.ts` (`channelOfVersion`,
      `effectiveChannel`/`resolveChannel`, `npmDistTags`/`trayReleaseTags`, `bestOf`,
      `persistChannel`), full prerelease ordering in `semver-lite.ts`, the channel threaded through
      `update-check.ts` / `update.ts` / `install-app.ts`, sticky-membership persist in `self-update`,
      the `update.channel` config key, and 30 unit tests.
      The decision function is split out as pure `effectiveChannel` because `GLOBAL_CONFIG_FILE`
      resolves `$HOME` at import time and apps/cli tests have no HOME isolation — a test of
      `resolveChannel`/`persistChannel` would read and *write* the real global config.
- [x] **Phase 2** — publishing: `nightly` arm (section 9) in `.claude/commands/release-notes.md`;
      `tray-nightly` support in `../agentbox-tray/scripts/publish-release.sh`, deriving the channel
      from the version string so the tag can't disagree with it.
- [x] **Phase 3** — `box-image.yml` and `ci.yml` run on `nightly`; the floating `:latest` /
      `:<version>` tags gated to `main` / `v*` refs.
- [x] **Phase 4** — tray `UpdateChecker.swift`: channel-aware CLI + app checks, both polling stable
      and nightly on the nightly channel, and a full prerelease-aware `isNewer`.
- [x] **Phase 5** — docs: `apps/web/content/docs/nightly.mdx` (+ `meta.json`), `cli.mdx`,
      `configuration.mdx`, `docs/development.md` (Branches + "Cutting a nightly"), `README.md`,
      `CHANGELOG.md`, and the tray's `README.md` / `CLAUDE.md`.

## Verified locally

Against a real `npm pack` tarball of `0.28.0-nightly.202607251205` installed into a clean prefix with
an isolated `$HOME` (never the dev symlink — see "Found by the tarball verification"):

- `agentbox --version` reports the prerelease.
- With **no config at all**, the CLI derives the nightly channel from its own version — the
  `self-update` report says `[nightly channel]`.
- It polls both dist-tags and refuses to downgrade: with no `nightly` tag published, `latest` (0.27.0)
  loses to the installed prerelease and the install step is skipped.
- `--channel stable` reports `switching to the stable channel: 0.28.0-nightly.… → 0.27.0` and plans
  `npm install -g @madarco/agentbox@0.27.0` — the opt-out.
- `--channel nightly` from a nightly build correctly does nothing.
- `--channel bogus` is rejected.
- `update.channel` round-trips through `config set`/`get`, lands as `update: channel: nightly` in
  `config.yaml`, refuses `weekly`, and a persisted `stable` overrides a nightly build.

## Still to do — the live pass

Needs a real publish:

1. `npm publish --tag nightly` and then **`npm view @madarco/agentbox dist-tags`** — `latest` must be
   unchanged. This is the one irreversible step.
2. Confirm the GHCR fingerprint tag for the nightly commit exists
   (`docker buildx imagetools inspect ghcr.io/madarco/agentbox/box:sha-<16hex>`, sha from
   `node apps/cli/scripts/print-box-context-sha.mjs`) and that `:latest` still points at the
   main-built manifest.
3. **The crossover**, once a stable release follows a nightly: a machine on `0.28.0-nightly.*` must be
   offered `0.28.0`, and after updating, `agentbox config get update.channel` must still read
   `nightly`. The last assertion is the one that catches silently dropping off the channel — the first
   two can pass while it fails.

## Found by the tarball verification

The plan called for packing a nightly and installing it into a clean prefix rather than trusting the
dev CLI. That paid for itself three times — none of these were visible from the workspace, and two
were silent:

1. **`ws` was missing from the published dependency list, so the CLI crashed on *every* command.**
   `@daytona/sdk` pulls `isomorphic-ws`, whose `ws` is an undeclared peer; npm installs no undeclared
   transitive peer. pnpm's dev tree happens to have `ws` hoisted, which is why it survived into
   **released 0.27.0** — `npm i -g @madarco/agentbox@0.27.0` into a clean prefix dies with
   `Cannot find module 'ws'`. Fixed by declaring it in `apps/cli`, with
   `apps/cli/test/runtime-deps.test.ts` guarding it (it has no importer, so it reads as removable).
2. **`self-update` could silently downgrade.** `newest` is only "newest *published*", and on nightly
   the installed build is routinely ahead of both dist-tags (between publishes). The old code always
   installed `newest`, so a nightly tester's next `self-update` would have moved them back to the last
   stable. Now guarded by `decideSelfUpdate`.
3. **…and the first fix for that was too broad.** Letting any explicit `--channel` bypass the guard
   meant `--channel nightly` *also* installed the older stable — the opposite of the request. The rule
   is narrower: a backward move is only allowed when the installed build's channel differs from the
   target, i.e. when genuinely *leaving* a channel. Unit tests passed against the wrong rule; running
   the real binary is what caught it.

Also worth knowing: **`npm pack` does not run `prepublishOnly`** (only `npm publish` does), so a pack
uses whatever `dist/` already exists. Since the version is baked in at build time by tsup's `define`,
a pack taken straight after `npm version` reports the *old* version. Build explicitly before packing
when verifying. The real publish path is fine — turbo does invalidate on the version change.

## Gotchas found while planning

Each of these is a silent failure — nothing errors, the channel just quietly misbehaves.

- **`npm publish` without `--tag nightly` moves `latest` onto the prerelease**, breaking every stable
  user. This is the one irreversible mistake in the flow (npm versions can't be replaced), so the
  skill must state it and the release check must assert `latest` is unchanged afterwards.
- **`box-image.yml` must run on `nightly`.** The CLI pulls the box image by build-context fingerprint
  (`registryRefForSha`), and only `main` pushes publish those tags today. Without this, every nightly
  tester silently falls into a ~10-minute local docker build, and Daytona degrades to a container
  class outright — it can only bake a VM snapshot from a *published* image.
- **…but the floating tags must stay on `main`.** `box-image.yml` claims `:$VERSION` and `:latest` on
  the native leg; running it on `nightly` unguarded would point GHCR's public `latest` at a nightly
  image.
- **The tray's source git tag must be skipped for nightly.** `publish-release.sh` tags the private
  repo `v$VERSION`, and the release-notes tray check anchors on `git describe --tags --abbrev=0`. A
  nightly tag there makes the "any app commits since its last release?" check go permanently empty
  for stable.
- **Both `isNewer` implementations drop the prerelease suffix** before comparing — `semver-lite.ts`
  returns `null` for a prerelease, and the tray's Swift version strips it. Either way,
  nightly-to-nightly comparison is a no-op and testers are never told about a newer nightly.

## Known caveats — documented, not solved

- **Channels share `~/.agentbox` entirely** — boxes, hub, secrets, and
  `~/.agentbox/<provider>-prepared.json`. Switching channels can force a cloud re-bake when the baked
  assets differ (minutes on hetzner/e2b/vercel), and a nightly carrying a state-schema change affects
  stable use afterwards. Per-channel isolation isn't worth building; the public docs page says so.
- **A nightly cut from a branch other than `nightly`** whose box-context files differ from anything
  published still falls back to a local image build. Phase 3 covers the `nightly` branch only.
- The `nightly` branch was previously undocumented — it appeared exactly once in the repo, in
  `.claude/commands/release-notes.md`. Phase 5 names it as the integration branch in
  `docs/development.md`.
