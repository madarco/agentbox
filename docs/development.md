# Development

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md).

## Build + verify

```sh
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

## Host skills + Codex plugin in dev

The `/agentbox` host skills and the Codex plugin are wired so a **source checkout
reflects your edits without re-publishing**, while a published npm install pulls
from the GitHub repo. The discriminator is `isSourceCheckout()` /
`resolveDevRepoRoot()` in `apps/cli/src/lib/source-checkout.ts` — every
distribution path lives under a `node_modules` segment; a clone does not.

- **Claude / OpenCode skills** — `agentbox install` (or `--skills-only`) symlinks
  `~/.claude/skills/agentbox-info` → `apps/cli/share/host-skills/agentbox-info/SKILL.md`
  in a checkout (copies on an npm install). Edit the **canonical**
  `apps/cli/share/host-skills/agentbox-info/SKILL.md`; it's live immediately.
- **Codex plugin** — `agentbox install codex` from a checkout points
  `[marketplaces.agentbox]` at the local repo (`source_type = "local"`) instead of
  the `madarco/agentbox` GitHub slug, re-syncs the bundle skill copy
  (`scripts/check-plugin-skill-sync.mjs --fix`), `codex plugin add`s from the
  working tree, then symlinks the staged `skills/<name>/SKILL.md` back to the repo.
  Skill edits then go live on the next Codex restart — no re-stage.
  - Codex re-derives "installed" from the staged dir, so we symlink only the skill
    *files*, not the whole staged dir (a dir symlink makes Codex report the plugin
    "not installed").
  - The Codex bundle keeps a **real copy** of the skill at
    `plugins/agentbox/skills/agentbox-info/SKILL.md` (Codex won't follow a symlink
    out of a bundle when it copies on publish). Edit the canonical and run
    `pnpm check:plugin-skill --fix` to propagate; CI runs `pnpm check:plugin-skill`.
  - Re-run `agentbox install codex` after **manifest/command** changes (not needed
    for skill text). Use `agentbox install codex --no-dev` to force the published
    GitHub path even inside a checkout (it flips the marketplace back to git).

## Manual end-to-end

Each long-running CLI command tees its output to `~/.agentbox/logs/<command>.log`
and prints the path on startup. When iterating, **don't block on `agentbox create`
with a long timeout** — start it in the background and tail the log instead
(`tail -f ~/.agentbox/logs/latest.log`). Same for `agentbox claude` / `codex` /
`opencode`. See [CLAUDE.md](../CLAUDE.md) for the full testing/verifying
workflow and the `pnpm drive` harness for interactive TUIs.

A representative loop:

```sh
node apps/cli/dist/index.js create -y -n smoke              # tail logs/latest.log
node apps/cli/dist/index.js checkpoint create smoke --set-default
node apps/cli/dist/index.js claude --host-snapshot -y -n cc -- --model sonnet
# (in tmux) Ctrl+a d to detach; reattach with `agentbox attach cc`
node apps/cli/dist/index.js status smoke --inspect
node apps/cli/dist/index.js destroy smoke -y
node apps/cli/dist/index.js destroy cc -y
```

For the full lifecycle command list see [`docs/features.md`](./features.md).

### Notion integration — nested-box dev only

Normal users never touch this. The `notion`/`ntn` integration works for any box
purely through the host relay (the box holds no token), and on macOS the host
just needs `ntn login` (keychain) — the connector forces **no** auth env, so the
relay, `agentbox doctor`, and the public docs all agree.

The one exception is AgentBox **dogfooding its own integration** — exercising it
from a *nested* box (a box that runs its own relay for boxes it creates). A Linux
box has no keychain, so for the carried credential to be readable there you must
log the **host** `ntn` in with file-based auth instead of the keychain:

```sh
NOTION_KEYRING=0 ntn login     # writes ~/.config/notion/auth.json
```

The `carry:` block in `agentbox.yaml` then ships that file into the box. Because
the connector no longer forces `NOTION_KEYRING=0`, when you run `ntn` *inside* the
box you may also need to export `NOTION_KEYRING=0` there so it reads the carried
file rather than looking for a keychain. (This nested path is internal-dev-only
and not yet run end-to-end.)

## Image: pull vs rebuild

The box image is pinned to `agentbox/box:dev` and reused across creates. On
first use the CLI **pulls** a prebuilt copy from GHCR
(`ghcr.io/madarco/agentbox/box`) instead of building locally — a multi-minute
build collapses to a `docker pull`. The pull target is tagged by the
build-context fingerprint (`sha-<first 16 hex>`, see `registryRefForSha()` in
`image.ts`), so the tag *is* the content identity: a fingerprint that matches a
published build pulls cleanly; one that doesn't (a locally edited baked file)
404s and the CLI builds locally. `ensureImage()` / `DockerProvider.prepare()`
go through `pullOrBuild()`.

Force a local build (skip the pull):

```sh
agentbox prepare --provider docker --build   # or: agentbox create --build
agentbox config set --global box.imageRegistry ""   # disable pulling everywhere
```

After **any** change that bakes into the image, wipe the cached copy so the next
create rebuilds:

```sh
docker rmi agentbox/box:dev
```

`agentbox self-update` does this for you. Anything `COPY`'d in
`packages/sandbox-docker/Dockerfile.box`, or listed as a context file in
`apps/cli/scripts/stage-runtime.mjs`, needs a rebuild — the Dockerfile and the
stage script are the authoritative list.

Wipe everything if state drifts: `agentbox prune --all -y`.

### Publishing the prebuilt image

`.github/workflows/box-image.yml` builds a multi-arch (amd64 + arm64) manifest
and pushes it to GHCR, tagged `sha-<fingerprint>`, `<cliVersion>`, and `latest`.
It runs on `workflow_dispatch`, on `v*` tags, and on `main` pushes that touch the
build context (`Dockerfile.box`, the docker scripts, `packages/ctl/**`,
`apps/cli/share/**`). The fingerprint is computed by
`apps/cli/scripts/print-box-context-sha.mjs` (same inputs as the runtime
fingerprint — verified equal locally).

**One-time setup:** after the first successful publish, make the GHCR package
public (repo → Packages → `box` → Package settings → Change visibility →
Public), otherwise anonymous `docker pull` from end users fails and they fall
back to building locally.

## Host environment assumed

macOS (arm64 tested), Docker via OrbStack or Docker Desktop. Container needs
`--cap-add=SYS_ADMIN --device=/dev/fuse --security-opt=apparmor:unconfined` —
`runBox` in `packages/sandbox-docker/src/docker.ts` is the single source of
truth for those flags.

## Releasing

Only `@madarco/agentbox` (`apps/cli`) is published. Releases are driven from the
commit history — there is no Changesets step.

1. **Generate the notes.** Run the `/release-notes [patch|minor|major]` slash
   command in Claude Code from the repo root. It reads the commits since the last
   `vX.Y.Z` tag, curates them into a short user-facing entry (grouped Breaking /
   Added / Changed / Fixed), and prepends it to `apps/cli/CHANGELOG.md`. Review
   and edit the entry — it is a draft, not the final word.
2. **Cut the release.** From `apps/cli`, run the matching publish script:

   ```sh
   pnpm --filter @madarco/agentbox run publish:minor   # or publish:patch
   ```

   `npm version` bumps `package.json`; the `version` lifecycle script stages
   `CHANGELOG.md` so both land in one commit; npm tags it `vX.Y.Z` and the script
   pushes the commit + tag. That tag is the anchor for the next `/release-notes`.
3. **Publish to npm.** `cd apps/cli && npm publish` (`prepublishOnly` rebuilds
   the workspace first). `CHANGELOG.md` ships in the tarball (it is in the package
   `files` list) — npm surfaces it on the package page.

The first tracked release is tagged `v0.9.0`; earlier history lives in the git
log.
