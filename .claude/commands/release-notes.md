---
description: Curate a CHANGELOG.md entry from commits since the last release; with a bump arg, also version, commit, and push the tag — then hand the npm publish to the user (they publish manually). `nightly` instead cuts a pre-release from the nightly branch. Also flags when the separately-published provider SDK needs a republish.
argument-hint: "[patch|minor|major|nightly]"
allowed-tools: Bash(git describe:*), Bash(git log:*), Bash(git tag:*), Bash(git rev-list:*), Bash(git rev-parse:*), Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(node:*), Bash(npm version:*), Bash(npm view:*), Bash(npm pack:*), Bash(cp:*), Bash(mktemp:*), Bash(tar:*), Bash(rm:*), Bash(pnpm:*), Read, Edit
---

You are writing the next release-notes entry for `@madarco/agentbox`. The
changelog is at `apps/cli/CHANGELOG.md` (Keep a Changelog format). Produce
**short, user-facing notes — not a commit dump.**

**If `$ARGUMENTS` is `nightly`, skip to section 9** — a nightly is a different
flow (pre-release version, `[Unreleased]` instead of a version heading, no git
tag, `--tag nightly` on the publish). Sections 1-3 still apply for gathering and
curating the notes; 4, 5, 6 and 8 do not.

## 1. Find the range

- Last release anchor: `git describe --tags --abbrev=0` (e.g. `v0.9.0`). If that
  fails (no tags), fall back to the last `New release` commit:
  `git log --grep='^New release$' -1 --pretty=%H`.
- The range is `<anchor>..HEAD`.

## 2. Gather material (not just subjects)

- `git log <anchor>..HEAD --no-merges --pretty=format:'===%h %s%n%b'` — read the
  **bodies**, they carry the real "why".
- `git log <anchor>..HEAD --stat --oneline` — gauge surface area.
- If a commit message is thin but the diff looks user-visible, inspect it with
  `git log -1 -p <hash> -- <path>`.

## 3. Curate — this is the point

- **Drop noise:** merge commits, CI / typecheck / lint / bugbot fixes, version
  bumps, and internal refactors or doc/copy tweaks with no user-visible effect.
- **Merge related commits** into a single bullet (e.g. several `feat(vercel)` /
  `fix(cloud)` commits → one "Vercel provider" line). Aim for a handful of
  bullets per heading, not one per commit.
- **Group** under these headings, in this order, omitting any that are empty:
  `### Breaking`, `### Added`, `### Changed`, `### Fixed`, `### Removed`.
- **Rewrite for a CLI user:** what changed for someone running `agentbox`, terse,
  past tense, no commit hashes. Mention the flag / config key / command name when
  relevant. Call out anything that breaks existing scripts under Breaking.

## 4. Pick the version

- Decide the bump from the commits: any breaking change → minor while pre-1.0
  (note it under Breaking), any `feat` → minor, else patch. Compute the next
  version from the current `apps/cli/package.json` `version`.
- If `$ARGUMENTS` names a bump (`patch` / `minor` / `major`), use that instead.

## 5. Write it

- Read `apps/cli/CHANGELOG.md`, then **prepend** a new section directly under the
  intro, above the most recent existing version:

  ```
  ## [<next-version>] - <today's date, YYYY-MM-DD>

  ### Added
  - ...
  ```

  Use today's real date — get it from the environment context, do not invent one.
- Print the entry you wrote.

## 6. Provider SDK — republish check (always run)

`@madarco/agentbox-provider-sdk` (`packages/provider-sdk`) is published
**separately** from the CLI and is **not** covered by the `@madarco/agentbox`
publish. External plugins depend on it, so a stale published SDK silently breaks
them. Run this check every time:

1. **Did the range touch its surface?** The SDK re-exports from `@agentbox/config`,
   `@agentbox/core`, `@agentbox/sandbox-cloud`, `@agentbox/sandbox-core`, plus its
   own package:
   ```
   git diff --name-only <anchor>..HEAD -- packages/provider-sdk packages/config packages/core packages/sandbox-cloud packages/sandbox-core
   ```
   No files listed → the SDK is unaffected; skip the rest of this section.

2. **Confirm it's a real *interface* change** (step 1 over-triggers on internal-only
   edits). Build the SDK and diff its generated types against what's on npm:
   ```
   pnpm --filter @madarco/agentbox-provider-sdk build
   pub=$(npm view @madarco/agentbox-provider-sdk version 2>/dev/null)
   # empty $pub → never published → it needs its FIRST publish; skip the diff, treat as changed.
   tmp=$(mktemp -d); npm pack @madarco/agentbox-provider-sdk@"$pub" --pack-destination "$tmp" >/dev/null
   tar -xzf "$tmp"/*.tgz -C "$tmp"
   git diff --no-index "$tmp/package/dist/index.d.ts" packages/provider-sdk/dist/index.d.ts; rm -rf "$tmp"
   ```
   No diff → interface unchanged (internal-only edit); skip the rest. A diff → the
   public surface changed.

3. **If the interface changed:**
   - **Bump `packages/provider-sdk/package.json` `version`** — minor for additive-only,
     **major** for any removed / renamed / retyped export. A major (breaking) change
     **also** bumps `SDK_API_VERSION` in `packages/provider-sdk/src/index.ts`, and that
     new value must be added to the CLI's `SUPPORTED_SDK_API_VERSIONS`
     (`packages/sandbox-core/src/plugin-registry.ts`).
   - Add a short SDK line to the changelog entry (under `Added` / `Changed` / `Breaking`).
   - Sanity-gate the artifact: `pnpm --filter @madarco/agentbox-provider-sdk pack:test`.
   - When releasing (section 8), stage `packages/provider-sdk/package.json` (+
     `src/index.ts` if `SDK_API_VERSION` changed, + the plugin-registry file) into the
     `release:` commit.
   - **Warn the user, prominently:** `@madarco/agentbox-provider-sdk@<new>` must be
     **republished separately** — the CLI publish does not cover it. Give the exact
     command to run in their own terminal (same 2FA/redaction reasons as the CLI
     publish — do **not** run it for them):
     ```
     ! cd packages/provider-sdk && npm publish --auth-type=web
     ```
     (`prepublishOnly` rebuilds dist; scoped `access: public` is already set.)

## 7. Menu-bar app — publish check (always run)

The macOS menu-bar app lives in the sibling repo `../agentbox-tray` and is
published **separately** from the CLI: signed + notarized artifacts on the
public repo's moving **`tray-latest`** GitHub release (`madarco/agentbox`).
The npm publish does **not** cover it, and `agentbox install tray`,
`self-update`, and the daily update nudge all compare the release's
`AgentBox.zip.sha256` sidecar — so a stale published build silently keeps
users on the old app. Run this check every time:

1. **Any app commits since its last release?** The tray now mirrors this repo's
   branch model: features land on its **`nightly`** branch and `main` is
   fast-forwarded at release time, so the range must be measured against
   `origin/nightly` — `origin/main` only moves when a release is cut, which would
   make this check read empty forever.
   ```
   git -C ../agentbox-tray fetch origin --tags 2>/dev/null
   anchor=$(git -C ../agentbox-tray describe --tags --abbrev=0 origin/nightly)
   git -C ../agentbox-tray log "$anchor"..origin/nightly --oneline
   ```
   The tag anchor still works because nightlies deliberately don't tag, so
   `describe` on `nightly` resolves to the last stable release.
   Empty → the published app is current; skip the rest. Non-empty → the app
   needs a release.

2. **Tell the user, prominently, in the same message as the changelog entry**
   — they will usually want the app and the CLI to ship together. If the app
   changes are user-visible, they likely already earned a changelog bullet in
   section 3 (the app updates via the CLI, so its changes belong in this
   changelog too).

3. **Only publish with explicit consent.** A bump in `$ARGUMENTS` consents to
   the CLI release flow (section 8) — it does **not** cover the app. Ask the
   user first (e.g. via a question with the app-version proposal) and publish
   only after they say yes. Next app version = bump the `anchor` tag. Do **not**
   read `../agentbox-tray/VERSION` for it — after a nightly that file holds a
   pre-release (`0.1.15-nightly.<stamp>`), not the published version; the last
   `v*` tag and `tray-latest`'s `version.json` are the real anchors.
   ```
   cd ../agentbox-tray && git switch main && git merge --ff-only nightly \
     && AGENTBOX_NOTARY_PROFILE=AGENTBOX_NOTARY ./scripts/publish-release.sh <next-app-version>
   ```
   - `AGENTBOX_NOTARY_PROFILE` is **load-bearing**: without it `release.sh`
     builds signed-but-unnotarized and `publish-release.sh` refuses to publish.
     Notarization waits on Apple (~a few minutes) — run it in the background.
   - Cut stable from the tray's **`main`** (fast-forward it from `nightly`
     first); the script refuses off `main`. It replaces the `tray-latest` assets
     (dmg + zip + `.sha256` sidecars + `version.json`), then commits the
     `VERSION` bump (`release: v<version>`), tags `v<version>`, and pushes — you
     no longer commit that by hand. No PR flow on the tray repo.
   - Verify: `gh release view tray-latest -R madarco/agentbox --json body`
     shows the new version.
   - **Nightly runs** publish to the separate `tray-nightly` release instead, so
     `tray-latest` is untouched. The tray computes its own version — don't stamp
     one by hand:
     ```
     cd ../agentbox-tray && git switch nightly && AGENTBOX_NOTARY_PROFILE=AGENTBOX_NOTARY \
       ./scripts/publish-release.sh nightly
     ```
     It derives `<next patch of the published stable>-nightly.<UTC stamp>`, skips
     the source git tag, and commits the bump itself. `--dry-run` shows the
     resolved version and notes without building. Nightly tray publishes are
     optional — a nightly CLI falls back to the stable tray automatically when
     `tray-nightly` doesn't exist or is older.

## 8. Release (only when `$ARGUMENTS` named a bump)

If `$ARGUMENTS` did **not** name a bump (`patch` / `minor` / `major`), stop here so
the user can review and edit the changelog before releasing — do not bump or push.

**Consent boundary.** The bump argument authorizes exactly the steps written in
this section: the version bump, the `release:` commit, the tag, and pushing
those to the release branch. It does **not** authorize anything else — never
merge or fast-forward branches (e.g. bringing `nightly` into `main` to release
it), push other branches, publish the menu-bar app, or publish anything to npm
without asking the user first. If the release requires one of those (e.g. main
is behind nightly and needs a fast-forward before tagging), stop and ask before
doing it.

Otherwise continue. **The user publishes to npm manually** — your job is to do
everything up to and including pushing the tag, then hand the publish command to
the user. Do **not** run `npm publish` yourself: 2FA auth requires either a live
web-auth URL or a fresh TOTP code, and the web-auth URL gets **redacted to `***`**
when it passes through the tool-output channel (and piping the command to
`tail`/anything makes npm treat the session as non-interactive and bail with
`EOTP`). So the publish must run in the user's own terminal.

1. **Bump `package.json` (no commit, no tag yet).** Section 5 just edited the
   changelog, so the tree is dirty and a plain `npm version` would abort with
   `EGITDIRTYWORKINGDIR`. Bump the version field only, from the package dir:
   `cd apps/cli && npm version <bump> --no-git-tag-version`
   (this is the version you already wrote into the changelog heading).

2. **Commit the changelog + bump together, and tag.** One commit:
   ```
   git add apps/cli/CHANGELOG.md apps/cli/package.json
   git commit -m "release: v<next-version>"
   git tag v<next-version>
   ```
   (Stage whatever actually changed — add the root `CHANGELOG.md` too if you edited it.)
   Note `npm version` runs a `version` script that already `git add`s the
   changelog, so it may be staged for you. Before tagging, check `git tag -l
   v<next-version>` — if a tag already exists (e.g. a concurrent session prepared
   the release on another branch), **stop and ask the user** how to reconcile;
   don't blindly move it.

3. **Push the commit and tag.** Check the current branch first (`git rev-parse
   --abbrev-ref HEAD`). If it is not `main`, tell the user and confirm they want to
   release from this branch. Then push the commit and the tag. `git push
   --follow-tags` only pushes **annotated** tags — the lightweight `git tag
   v<next-version>` above is **not** pushed by it, so push the tag explicitly:
   ```
   git push
   git push origin v<next-version>
   ```
   Verify with `git ls-remote --tags origin v<next-version>`.

4. **Hand the publish to the user.** Verify the version is not already on the
   registry (`npm view @madarco/agentbox@<next-version> version` should print
   nothing / 404). Then restate package (`@madarco/agentbox`), the new version,
   the branch, and the pushed tag/commit, and give the user the exact command to
   run **in their own terminal** (the `! ` prefix runs it in this session so the
   web-auth URL lands unredacted):
   ```
   ! cd apps/cli && npm publish --auth-type=web
   ```
   `prepublishOnly` rebuilds the whole workspace first, so this also runs the full
   build. npm will print a clickable web-auth URL (or, with classic TOTP, prompt
   for a 6-digit code — re-run with `--otp=<code>`); it completes the publish
   automatically once auth lands. Do **not** run this for them.

5. **Optionally confirm afterward.** If the user reports the publish succeeded,
   `npm view @madarco/agentbox version` should show <next-version>. Report the
   published version, the pushed tag, and the commit.

## 9. Nightly (only when `$ARGUMENTS` is `nightly`)

A nightly is a **pre-release** published under the `nightly` dist-tag so testers
can run what's on the `nightly` branch before it ships. Design and rationale:
[`docs/nightly-channel-plan.md`](../../docs/nightly-channel-plan.md).

Do sections 1-3 first (find the range, gather, curate), with one difference in
section 1: the anchor is the **last nightly**, not the last release —
`git log --grep='^chore(release): nightly' -1 --pretty=%H`. Fall back to
`git describe --tags --abbrev=0` when there has never been a nightly.

Then:

1. **Refuse to run from the wrong branch.** `git rev-parse --abbrev-ref HEAD`
   must be `nightly`. If it isn't, stop and tell the user — a nightly cut from a
   feature branch publishes code that was never integrated.

2. **Compute the version: `<next-minor>-nightly.<YYYYMMDDHHmm UTC>`.**
   ```
   base=$(npm view @madarco/agentbox version)            # the published STABLE release
   stamp=$(date -u +%Y%m%d%H%M)
   ```
   Bump `base`'s **minor** (`0.27.0` → `0.28.0`) and append `-nightly.$stamp`.

   **Take the base from the published release, NOT from `apps/cli/package.json`.**
   After a previous nightly the branch's own version reads `0.28.0-nightly.<old>`,
   whose minor-bump is `0.28.0` — which merely *ties* the stable release instead of
   outranking it, producing a nightly that no tester is ever offered. The
   published release is the only stable anchor.

   Naming a nightly for the version it *precedes* is what makes a stable release
   supersede it automatically (`0.28.0` > `0.28.0-nightly.x`), so nightly testers
   get releases with no second publish under the `nightly` tag.

3. **Write the notes into `## [Unreleased]`** — do **not** create a version
   heading. Nightly notes accumulate there and are promoted verbatim when the real
   release is cut. Add bullets under the usual `### Added` / `### Changed` /
   `### Fixed` sub-headings, merging with whatever is already there.

4. **Commit the changelog + the version bump, and do NOT tag.**
   ```
   cd apps/cli && npm version <version> --no-git-tag-version && cd ../..
   git add apps/cli/CHANGELOG.md apps/cli/package.json
   git commit -m "chore(release): nightly v<version>"
   git push
   ```
   Tags are a stable-release artifact — a `v*` tag here would also trigger the
   box-image workflow's release path.

5. **Hand the publish to the user** (same 2FA/redaction reasons as section 8 — do
   **not** run it yourself):
   ```
   ! cd apps/cli && npm publish --tag nightly --auth-type=web
   ```
   **`--tag nightly` is load-bearing.** Without it npm moves the `latest`
   dist-tag onto the pre-release, and *every stable user* gets a nightly on their
   next install or `self-update`. npm versions cannot be replaced, so this is the
   one irreversible mistake in the flow — restate the exact command with the flag,
   and never offer a form without it.

6. **Verify afterwards, and check `latest` did not move:**
   ```
   npm view @madarco/agentbox@nightly version     # the new pre-release
   npm view @madarco/agentbox dist-tags           # `latest` must be UNCHANGED
   ```
   The second is the regression check for step 5. Report both.

7. **Skip the provider-SDK check (section 6)** — the SDK has its own semver line
   and no nightly channel. **Do run the tray check (section 7)** if the app
   changed; its nightly command is `./scripts/publish-release.sh nightly`, run
   from the tray's `nightly` branch (it computes its own version, derives the
   channel from it, and skips the source git tag). The tray's version line is
   independent of the CLI's — don't pass it the CLI's version.
