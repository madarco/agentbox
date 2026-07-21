---
description: Curate a CHANGELOG.md entry from commits since the last release; with a bump arg, also version, commit, and push the tag — then hand the npm publish to the user (they publish manually). Also flags when the separately-published provider SDK needs a republish.
argument-hint: "[patch|minor|major]"
allowed-tools: Bash(git describe:*), Bash(git log:*), Bash(git tag:*), Bash(git rev-list:*), Bash(git rev-parse:*), Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(node:*), Bash(npm version:*), Bash(npm view:*), Bash(npm pack:*), Bash(cp:*), Bash(mktemp:*), Bash(tar:*), Bash(rm:*), Bash(pnpm:*), Read, Edit
---

You are writing the next release-notes entry for `@madarco/agentbox`. The
changelog is at `apps/cli/CHANGELOG.md` (Keep a Changelog format). Produce
**short, user-facing notes — not a commit dump.**

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

1. **Any app commits since its last release?**
   ```
   git -C ../agentbox-tray fetch origin --tags 2>/dev/null
   anchor=$(git -C ../agentbox-tray describe --tags --abbrev=0 origin/main)
   git -C ../agentbox-tray log "$anchor"..origin/main --oneline
   ```
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
   only after they say yes. Next app version = bump the `anchor` tag (the
   current version is in `../agentbox-tray/VERSION`):
   ```
   cd ../agentbox-tray && AGENTBOX_NOTARY_PROFILE=AGENTBOX_NOTARY ./scripts/publish-release.sh <next-app-version>
   ```
   - `AGENTBOX_NOTARY_PROFILE` is **load-bearing**: without it `release.sh`
     builds signed-but-unnotarized and `publish-release.sh` refuses to publish.
     Notarization waits on Apple (~a few minutes) — run it in the background.
   - The script tags the tray repo `v<version>` and replaces the `tray-latest`
     assets (dmg + zip + `.sha256` sidecars), but leaves its `VERSION` file
     bump uncommitted — commit it afterwards (`release: v<version>`) and push
     straight to the tray repo's main (no PR flow there).
   - Verify: `gh release view tray-latest -R madarco/agentbox --json body`
     shows the new version.

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
