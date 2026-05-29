# Plan — `gh` + `git` shims (host-mediated, no in-box credential bypass)

## Context

Two gaps inside an agentbox box:

1. **Claude Code's PR badge stays dark.** Claude Code populates the bottom "branch → PR #N" badge (and `pr.number` / `pr.url` / `pr.review_state` in statusline JSON) by shelling out to `gh pr view --json …`. There is no REST-API fallback, no `.git/config` lookup, no env override — `gh` *must* be on the box's `PATH` and `gh auth status` must succeed. The box has no `gh` today, and giving the in-box agent a GitHub token is explicitly off-limits.

2. **Agents call raw `git push`/`pull`/`fetch`/`clone` and fail.** The only working path is `agentbox-ctl git push|fetch|pull` (host-mediated via the relay). Claude Code and any tool that just shells out to `git` doesn't know to call `agentbox-ctl`.

### Design principle: host-only execution, no credential proxies

**Every credential-touching operation runs on the host, via the relay's wire protocol, and only the result (stdout / stderr / exitCode / occasionally a binary blob) crosses back into the box.**

- No SSH agent forwarding into the box.
- No git credential helper / askpass that hands the box a transient token.
- No host-side socket that the box can use to silently borrow creds.

A prior ssh-A + git-credential-proxy fast path exists on the unmerged branch `feat/hetzner-git-fast-path` (commit `9d88309`). It is **not** adopted here and is not on the current branch — a compromised in-box agent could exfiltrate creds during the proxy window. This plan ships only the host-only path; if that branch is ever revisited, this principle still applies.

### Argument policy: strict subset, "better safe than compatible"

The shims expose **only the flag/positional combinations needed for documented agent workflows.** Anything else — including flags real `gh`/`git` happily accept — gets rejected with a clear "not supported by agentbox shim" error. Goal is a small, auditable surface, not feature parity with the upstream binaries.

The relay already exposes `gh.pr.<op>` RPCs (8 ops; read-only ones skip the host prompt — `packages/relay/src/gh.ts`) and `git.push` / `git.fetch` RPCs (`git.push` auto-allows the per-box `agentbox/<name>` branch per commit `2a083d4`). What's missing: PATH-resident `gh` and `git` shims, one new `git.clone` RPC, one new `gh.repo.clone` RPC, per-command branch-ref injection in the gh shim.

## Approach

Three layers. Nothing in the box sees a credential.

### Layer 1 — `agentbox-ctl` surface

`packages/ctl/src/commands/gh.ts` (new top-level command):
- `agentbox-ctl gh pr <op> [args...]` — wire payload `{ method: 'gh.pr.<op>', params: { path, args } }`. Reuse `PR_SUBCOMMANDS` extracted from `commands/git.ts:55` into a shared `pr-subcommands.ts` (so `git pr` and `gh pr` stay in lockstep).
- `agentbox-ctl gh repo clone <repo> [dir]` — wires to new RPC `gh.repo.clone`.

`packages/ctl/src/commands/git.ts`:
- Add `clone` subcommand → new RPC `git.clone`.

`packages/ctl/src/bin.ts`:
- Register `ghCommand` alongside `gitCommand`.

### Layer 2 — PATH shims (bash, baked into the image)

Both live under `packages/sandbox-docker/scripts/` and `COPY` into `/usr/local/bin/{gh,git}` in `Dockerfile.box` next to `agentbox-open` (`:367`). Plain bash — no node startup per call; Claude Code may invoke `gh pr view` several times per second on refresh.

**Strict whitelist (better safe than compatible).** Each subcommand below lists exactly the args allowed. Anything else → exit 2 with `agentbox <shim> shim: unsupported '<token>' for '<subcmd>'. Allowed: <list>`.

**`/usr/local/bin/gh`**:

| Subcommand | Positional | Allowed flags | Auto-injected if missing |
| --- | --- | --- | --- |
| `--version` | — | — | — (static line) |
| `auth status` | — | (any, ignored) | — (local stub, exit 0) |
| `pr view` | optional ref | `--json <fields>` | positional ← `$BOX_BRANCH` |
| `pr list` | — | `--json <fields>`, `--state {open,closed,merged,all}` | `--head $BOX_BRANCH` |
| `pr create` | — | `--fill`, `--draft`, `--title <t>`, `--body <b>`, `--base <branch>` | `--head $BOX_BRANCH` |
| `pr comment` | optional ref | `--body <b>` | positional ← `$BOX_BRANCH` |
| `pr review` | optional ref | `--approve`, `--request-changes`, `--comment`, `--body <b>` | positional ← `$BOX_BRANCH` |
| `pr merge` | optional ref | `--squash`, `--merge`, `--rebase`, `--delete-branch` | positional ← `$BOX_BRANCH` |
| `pr close` | optional ref | `--delete-branch` | positional ← `$BOX_BRANCH` |
| `pr reopen` | optional ref | — | positional ← `$BOX_BRANCH` |
| `pr checkout` | required ref | — | — (also refused by default relay-side via `AGENTBOX_GH_PR_CHECKOUT`) |
| `repo clone` | `<repo> [dir]` | `--branch <n>`, `--depth <n>` | — |

- `$BOX_BRANCH=$(/usr/bin/git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null)` computed once.
- For each `pr` op, after validation the shim does `exec agentbox-ctl gh pr <op> -- "$@"`.
- Anything outside this table → exit 2 with shim-not-proxied message and the supported-list.

**`/usr/local/bin/git`**:

| Subcommand | Positional | Allowed flags |
| --- | --- | --- |
| `push` | rejected | `--force-with-lease` (only) |
| `pull` | rejected | `--ff-only` (only) |
| `fetch` | rejected | `--prune` (only) |
| `clone` | `<url> [dir]` | `--branch <n>`, `--depth <n>` |
| any other (`commit`, `status`, `log`, `diff`, `add`, `checkout`, `branch`, `stash`, `merge`, `rebase`, `show`, `rev-parse`, `worktree`, …) | passthrough | passthrough |

- `REAL_GIT=/usr/bin/git` resolved once at top. Shim must NOT loop — always `exec /usr/bin/git`, never `exec git`.
- Network ops (`push|pull|fetch|clone`): positional remote/branch rejected; the ctl rebuilds them from the registered worktree (re-passing them yields the `refs/remotes/origin/HEAD cannot be resolved` failure noted at `commands/git.ts:131`).
- For `push|pull|fetch`: `exec agentbox-ctl git <op> -- "$@"`. For `clone`: `exec agentbox-ctl git clone -- "$@"`.
- Any other first arg: `exec $REAL_GIT "$@"`. Zero overhead, zero shim output for everyday local git.
- PATH ordering already correct (`Dockerfile.box:50` puts `/usr/local/bin` before `/usr/bin`).

### Layer 3 — new relay RPCs

`packages/relay/src/gh.ts`, `packages/relay/src/host-actions.ts`, `packages/relay/src/server.ts`:

- **`gh.repo.clone`** — params `{ url, targetPath, args? }`. Relay-side whitelist (defense in depth): `--branch`, `--depth` only. Host runs `gh repo clone <repo> <hostTmp> <whitelistedArgs>` in `~/.agentbox/clones/<random>/` with host creds. Same prompt-on-the-host pattern as `gh.pr.create`.

- **`git.clone`** — params `{ url, targetPath, args? }`. Relay-side whitelist (`--branch`, `--depth`). Two-stage on the host:
  1. `git clone <url> <hostTmp> <whitelistedArgs>` (host creds, into `~/.agentbox/clones/<random>/`).
  2. `git bundle create <hostTmp>.bundle --all` → stream bundle bytes back to the box over the existing relay file-stream path (same plumbing as `cp` / `download`).
- Box-side ctl receives the bundle, runs `/usr/bin/git clone <bundle> <targetPath>`, then `git -C <targetPath> remote set-url origin <originalUrl>`, deletes the bundle. Host cleans up its tmpdir.
- Bundle transfer is the only mechanism that works identically on docker, daytona, and hetzner — no scp / bind-mount asymmetry.

- **Target-path validation** (both RPCs): must resolve inside the box's registered worktree root (typically `/workspace`); reject `..` escapes and absolute paths outside it. Reject if target dir exists and is non-empty.
- **URL validation** (both RPCs): only `https://github.com/...`, `git@github.com:...`, or `owner/name` shorthand. Reject `file://`, `ssh://` to non-github hosts, arbitrary URLs.

## Critical files

### New
- `packages/ctl/src/commands/gh.ts`
- `packages/ctl/src/commands/pr-subcommands.ts` (factored from `commands/git.ts`)
- `packages/sandbox-docker/scripts/gh-shim`
- `packages/sandbox-docker/scripts/git-shim`

### Modified
- `packages/ctl/src/commands/git.ts` — import shared `PR_SUBCOMMANDS`; add `clone` subcommand.
- `packages/ctl/src/bin.ts` — register `ghCommand`.
- `packages/relay/src/gh.ts` — add `repo.clone` whitelist + strict-args validator.
- `packages/relay/src/host-actions.ts` — add `runGhRepoCloneRpc`, `runGitCloneRpc`. Reuse existing file-stream for the bundle hop.
- `packages/relay/src/server.ts` — wire new RPC methods in the docker dispatch path.
- `apps/cli/runtime/docker/Dockerfile.box` — `COPY` both shims into `/usr/local/bin/{gh,git}` + `chmod +x`, after the `agentbox-ctl` COPY at `:141`.

### No changes needed
- Existing `git.push` / `git.fetch` RPCs (`packages/relay/src/host-actions.ts:572+`) — already correct host-side, including auto-allow for `agentbox/<name>` branches.
- Daytona / hetzner provider lifecycle — both inherit the same image. Rebake on next `agentbox prepare --provider hetzner` / Daytona snapshot refresh.
- The ssh-A / cred-proxy code on `feat/hetzner-git-fast-path` is unmerged and not on this branch; no removal needed here.

## Verification

1. **Unit tests** (`packages/ctl/test/`, `packages/relay/test/`):
   - ctl: `agentbox-ctl gh pr view --json number,url` → wire `{ method: 'gh.pr.view', params: { path, args: ['--json', 'number,url'] } }`.
   - ctl: `agentbox-ctl git clone https://github.com/x/y.git ./y --branch main` → wire whitelist-only flags.
   - relay: `gh.repo.clone` rejects `--reference` / `--template` (exit 22, clear stderr).
   - relay: `git.clone` rejects non-github URLs.
   - shim arg-whitelist: vitest spawns the bash shim against a stubbed `agentbox-ctl` on `PATH`; asserts exit code + stderr for disallowed flags and supported paths.
   - shim branch injection: `gh pr view` no-arg → positional `<box-branch>` injected; `gh pr view 42` → left alone.

2. **Image rebuild** (per CLAUDE.md, not `agentbox prepare` since the box runs without `CAP_SYS_PTRACE`):
   ```
   docker build --network=host -t agentbox/box:dev \
     -f apps/cli/runtime/docker/Dockerfile.box apps/cli/runtime/docker
   ```

3. **End-to-end smoke** (docker first). Use `../agentbox-test-repo-gh` — the test repo with an https origin specifically wired for `gh` (per CLAUDE.md):
   - From `../agentbox-test-repo-gh`, create a box: `node ../agentbox/apps/cli/dist/index.js create -y -n shim-smoke &`, then `tail -f ~/.agentbox/logs/create.log` until ready. The box's branch is `agentbox/shim-smoke`.
   - Host has `gh auth login` for github.com already. Inside the box (`agentbox shell shim-smoke`):
     - `gh --version` / `gh auth status` → exit 0.
     - `git commit --allow-empty -m "shim smoke"` (real git, no shim hit) → succeeds.
     - `git push` → relay accepts (auto-allow `agentbox/shim-smoke`); commit visible on `github.com/<owner>/agentbox-test-repo-gh` under that branch.
     - `gh pr create --fill --draft` → PR created against the repo's default branch with `head=agentbox/shim-smoke` (shim-injected). Note the PR number / URL.
     - `gh pr view --json number,url,state,reviewDecision` → JSON contains the new PR's number and URL.
     - `git pull --ff-only` → succeeds.
     - `git clone https://github.com/madarco/agentbox-test-repo.git ./clone-test --depth 1` → host clones into `~/.agentbox/clones/...`, bundles, ships back; `git -C clone-test log` shows commits, `git -C clone-test remote get-url origin` returns the original URL.
   - **Claude Code PR indicator** — the load-bearing UX check:
     - `agentbox claude -n shim-smoke` (or `agentbox claude --shared-docker-cache --carry-yes` for the agentbox-in-agentbox dev loop).
     - Drive the TUI via `pnpm drive` (`apps/cli/test/_harness/`): `pnpm drive start --name shim-claude -- node apps/cli/dist/index.js claude -n shim-smoke`, then `pnpm drive screen shim-claude` and assert the rendered terminal contains the PR badge (e.g. `PR #<num>` or `↑↓ #<num>` glyph, depending on Claude Code's current rendering). Tail the box's `~/.claude/statusline.json` if the visual is ambiguous — `pr.number` and `pr.url` should populate within a refresh tick.
     - Close the PR on the host (`gh pr close <num>` from the host main repo) and confirm the badge disappears on the next refresh — sanity-checks the shim isn't caching stale state.

4. **Negative paths** (inside the box):
   - `gh issue list` → exit 2 with shim "not proxied" message.
   - `gh pr view --comments` → rejected (flag not on the strict whitelist, even though real `gh` accepts it).
   - `git push origin some-branch` → rejected (positional refspec disallowed).
   - `git push --tags` → rejected (flag not whitelisted; we ship the minimum).
   - `git clone --recurse-submodules <url>` → rejected.
   - `git clone file:///tmp/foo` → rejected by relay URL validator.
   - `git status` / `git log` / `git checkout -b foo` → fall through to real git, no shim output.

5. **Provider cross-check** (after docker green):
   - `agentbox prepare --provider hetzner`, spin a hetzner box, repeat the smoke. Confirms bundle-transfer + relay-mediated `git.push` / `gh.pr.*` work cross-provider over the wire protocol (no ssh-A involved).
   - If `git.push` regresses on cloud providers (commits live in box-side `.git/` only), add a "sync box commits to host via bundle" preamble inside `git.push` — opposite direction of `git.clone`'s bundle hop. Same primitive, same PR.
   - Daytona uses the same image; usually no separate snapshot rebake needed unless `docs/cloud-create-flow.md` indicates otherwise.

## Deferred follow-ups

- **Widen the whitelist on demand.** Each new flag/op is a deliberate decision, not a default. Track requests; reject silently until requested.
- **Host worktree under `~/.agentbox/host-worktrees/<box-name>/`** — adopt when explicit-branch injection isn't enough (e.g. `gh pr status` or any gh/git subcommand hard-wired to HEAD). Would replace per-op injection with a uniform "relay runs everything in the box's worktree" model. *Update:* the explicit-branch path was made robust instead — the relay now resolves the box's **live** branch (docker: `git worktree list --porcelain` on the registered `gitWorktreePath`; cloud: live `git rev-parse` probe) and targets it for every `gh.pr.*` / `git.push` / `git.fetch` op, refusing rather than falling back to the host's checked-out branch. A host worktree is only needed if the shim whitelist grows to commands that can't take an explicit branch ref.
- **`gh issue` / `gh repo view` / `gh api`** — extend the gh shim surface when concrete agent flows need them. Each new op needs a matching relay RPC.
- **Prune integration** — `agentbox destroy` / `agentbox prune` should sweep leftover `~/.agentbox/clones/<random>/` tmpdirs.
