# Independent boxes — box-held git credentials (`git.pushMode=direct`, `--with-credentials`)

Status: implemented + live-verified on E2B (branch `feat/box-git-direct`).

## Verification results (2026-07-10, E2B)

- Host gate copies the creds (token + SSH private/public signing key), riding the carry apply path; box git config set (`credential.helper=store`, ssh host-key policy, signing). `AGENTBOX_GIT_DIRECT=1` in box.env.
- **An in-box commit pushed straight to GitHub with the host relay STOPPED** — verified from the host via `git ls-remote`. Core "PC off" claim holds.
- ctl direct-run branch (`git push`/`fetch`) verified locally against a bare remote with the fresh ctl (push+fetch land; without the flag it routes to the relay).

### Bugs found + fixed during verification
- **Box-user uid**: carry chowns to a fixed 1000, but the box user is 1001 on E2B/Vercel (1002 elsewhere) → the box couldn't read its own 0600 creds. `seedGitCredentials` now re-owns to `id -u`.
- **Passphrase signing key**: forcing `commit.gpgsign=true` breaks *every* commit when the SSH signing key needs a passphrase (no agent/askpass in the box). `seedGitCredentials` now probes `ssh-keygen -y -P ''` and only enables signing when the key is usable non-interactively.
- **Private key**: the gate now copies the *private* half of an SSH key pair, not just the `.pub`.

### Known limitations (v1, documented)
- The in-box `agentbox-ctl git push`/`git` shim direct-run needs the box to ship the **new ctl**; cloud base templates baked before this change route to the relay until re-prepared (`agentbox prepare --provider <name>`). The `AGENTBOX_GIT_DIRECT=1` flag is set regardless, so a re-prepared box uses the direct path with no further change. A plain `/usr/bin/git push` (what the ctl branch invokes) is independent today.
- **Passphrase-protected SSH *auth* keys** can't push over SSH non-interactively in the box (no agent). HTTPS-token remotes are unaffected. Passphrase *signing* keys leave signing off (commits succeed unsigned).
- `gh pr create` and other host ops (`cp`/`download`/`checkpoint`) still need the PC on (v1).

## Context

Today a box **cannot do git on its own**. A plain `git push` inside a box is intercepted by a
PATH shim (`/usr/local/bin/git` → `packages/sandbox-docker/scripts/git-shim`) that re-execs
`agentbox-ctl git push`, which routes the push through the **host relay**: for cloud boxes the
host laptop runs a `CloudBoxPoller` that drains the box's `/bridge/poll`, does a git-bundle
pull-back, and pushes with the host's SSH/gh credentials. **Turn the laptop off and every git
operation hangs until a 10-minute timeout, then fails.** Credentials deliberately never enter
the box — that is the security invariant the relay exists to preserve.

A host-independent path already exists — the **control plane** (`git.pushMode=lease`,
`AGENTBOX_GIT_LEASE=1`): the box leases a ≤1h GitHub-App token from a *deployed hosted hub* and
pushes straight to GitHub. But that requires standing up and running a hub (Vercel/VPS). Many
users want a **simpler shortcut**: for a box meant to stay on (Hetzner, future DigitalOcean) or
that pauses/resumes over HTTP (E2B, Vercel, Daytona), just **copy the user's own git credentials
into the box** so it pushes/pulls/signs directly — no hub, no host. The cost is a real security
tradeoff (credentials now live in the box and in its snapshots), so it is **opt-in, behind a loud
confirmation with a security warning**.

This work is **independent of and complementary to** the control-plane/hosted-hub work. It adds a
third `git.pushMode`: `direct`, exposed via the `--with-credentials` flag.

### Goal / non-goals

- **In scope (works with the PC off):** `git push`, `git fetch`, `git pull`, and `gh pr create`
  from inside the box, using credentials copied from the host. Both HTTPS+token remotes and
  SSH-key remotes. SSH **commit signing** (copy the signing key + config).
- **Stays host-only (unchanged):** `agentbox cp` / `download` (`cp.toHost`/`cp.fromHost`/
  `download.*`) and `checkpoint.create`. These route through the relay; with the PC off they
  should **fail with a clear message** ("requires your PC to be on"), not hang silently.
- **Follow-up (not built here):** host-off `checkpoint.create` would additionally require the
  **provider's** credentials in the box (so it can snapshot itself) — a separate, larger step.
- **Providers:** cloud only. `direct` is rejected for docker (the box already runs on the host
  machine, so independence is meaningless).

### Naming + the two credential shapes

`--with-credentials` (flag) → `git.pushMode=direct` (mechanism value). The gate **asks which
credential** to copy at an **interactive prompt** (the security trade-off). Copying a credential is
**interactive-only by design** — it requires a live TTY and a human choosing at the prompt; there
is NO non-interactive path (no flag value, no env var, no `-y`), so automation / CI / the `-i`
queue can't copy a secret without a person present. This is the shipped shape:

- **token** (recommended) — copy just a GitHub token (`~/.git-credentials`). Box pushes over
  **HTTPS**; a github SSH origin is rewritten to HTTPS via global `url.insteadOf` (both the scp
  `git@github.com:` and `ssh://git@github.com/` forms — multi-valued, so `--add`), so **no SSH key
  is ever copied**. Commits are unsigned.
- **ssh** — copy the SSH **private** key. Box pushes over SSH (HTTPS origin rewritten to SSH) and
  signs commits (guarded on a passphrase-less probe). Riskiest — a private key in the box.

`--with-credentials` always prompts (`token` / `ssh` / cancel) on a TTY and refuses on a non-TTY.
A token can't sign commits (that's what the SSH key is for); most agent workflows are fine with
unsigned commits, so token is the low-exposure default.

## Phases

### Phase 1 — Config surface: `git.pushMode='direct'` + `--with-credentials` flags

- `packages/config/src/types.ts`: add `'direct'` to `GitPushMode` (~line 41) and to the
  `enumValues` + description of the `git.pushMode` registry entry (~line 864). `auto` semantics
  unchanged (lease when a control-plane URL is set, else relay); `direct` is only ever explicit.
- `apps/cli/src/commands/{create,claude,codex,opencode}.ts`: add `--with-credentials` /
  `--with-credentials-yes` flags as sugar for `--git-push-mode direct`. These commands already
  thread `gitPushMode: cfg.effective.git.pushMode` into the provider
  (`apps/cli/src/commands/claude.ts:591,844`).
- Reject `direct` for docker with a clear error.

### Phase 2 — Detect + copy the credentials at create time (gated)

New module `apps/cli/src/lib/git-creds-gate.ts`, modeled on `apps/cli/src/lib/carry-gate.ts` +
`apps/cli/src/carry-prompt.ts`. Runs only when `git.pushMode === 'direct'` and provider is cloud:

1. **Detect** from the host repo's origin (`readGitOriginUrl`, `packages/sandbox-cloud/src/cloud-provider.ts:950`):
   - **HTTPS remote** → token via `git credential fill` (works across osxkeychain/store/gh
     helpers), fallback `gh auth token`. Box target: `~/.git-credentials` (0600) +
     `git config --global credential.helper store`.
   - **SSH remote** → resolve the key for the origin host (`~/.ssh/config`, else default
     `id_ed25519`/`id_rsa`). Copy the private key (+ `.pub`) to box `~/.ssh/` (0600) and add
     `github.com` to `~/.ssh/known_hosts`.
   - **Commit signing** (any remote scheme): if host `commit.gpgsign` is true and `gpg.format`
     is `ssh`, copy `user.signingkey` to box `~/.ssh/` and mirror `commit.gpgsign` /
     `user.signingkey` / `gpg.format` into box git config. (GPG-format signing keys: out of scope
     v1; detect and warn "not copied".)
2. **Choose + confirm** at an interactive prompt (`token` / `ssh` / cancel) with a redacted summary
   (path / token *source*, never the secret) + the security warning. **Interactive-only** — a
   non-TTY hard-errors; there is no flag value, env var, or `-y` bypass. Warning copy must state:
   the credential lives inside the box, the box user has passwordless sudo (no boundary inside), and
   **it is captured in any snapshot/checkpoint** (it must persist to survive resume, unlike relay
   tokens in ephemeral `/run`).
3. **Transfer** by synthesizing `ResolvedCarryEntry[]` (`packages/core/src/provider.ts:34-67`)
   with `mode: 0600`, `user: 1000`, reusing the cloud apply path
   `uploadCarryPaths` (`packages/sandbox-cloud/src/sync/carry.ts:35`) — **no new transfer code**.
4. Record an audit entry on `BoxRecord` (mirror `BoxRecord.carry`,
   `packages/core/src/box-record.ts:302`) — paths/sources only, never secret material.

### Phase 3 — Seed box git credential helper + signing config

Extend `packages/sandbox-cloud/src/sync/git-identity.ts` (or a sibling `seedGitCredentials`
called alongside `seedGitIdentity`) to additionally set `credential.helper=store` (HTTPS) and the
signing config (`commit.gpgsign` / `user.signingkey` / `gpg.format=ssh`) when `direct` mode is
active. Identity (name/email) is already seeded there.

### Phase 4 — Direct-run branch in the box

- `packages/sandbox-cloud/src/bootstrap-launch.ts` (~line 133): when `pushMode === 'direct'`,
  write `AGENTBOX_GIT_DIRECT=1` (parallel to `AGENTBOX_GIT_LEASE=1`) and `GH_TOKEN` into
  `/etc/agentbox/box.env` (the login shell that runs `git` sources box.env, not the daemon env —
  see `git.ts:96-102`). Persist `git.pushMode` on the box record so resume re-threads it (already
  the pattern at `packages/core/src/box-record.ts:162`, `provider.ts:163`).
- `packages/ctl/src/commands/git.ts`: `push` (~180), `fetch` (~201), `pull` (~223) — when
  `AGENTBOX_GIT_DIRECT === '1'`, run the **real** local `git push`/`fetch` (the box's configured
  credential helper / SSH key authenticates), skipping the relay RPC. Keep the shim's existing
  safety checks (`--force-with-lease` allowlist, no positional refspecs). Best-effort emit a
  status event to the relay if reachable (non-fatal). `pull`'s local merge step is unchanged.
- `gh` for `gh pr create`: with `GH_TOKEN` set, add an `AGENTBOX_GIT_DIRECT` fall-through so `gh`
  runs directly instead of routing to the relay.

### Phase 5 — Clarify cp/download/checkpoint error when PC is off

No routing change. When a host-routed RPC times out because nothing is draining `/bridge/poll`
(`relay-rpc.ts` `POLL_MAX_MS`), surface a clear message — *"cp/download/checkpoint need your PC
(host relay) running; this box's git is independent but these are not."* — instead of a silent
10-minute hang.

### Phase 6 — Tests, docs, e2e verification

Unit (vitest, pure — isolate `$HOME` per file, the apps/cli no-HOME-isolation caveat):
- `GitPushMode` accepts `direct`; `auto` unchanged.
- creds detection: HTTPS origin → token entry; SSH origin → key entry; signing config mirrored;
  synthesized `ResolvedCarryEntry` has `mode:0600`, `user:1000`.
- `git.ts` push/fetch selects direct-run when `AGENTBOX_GIT_DIRECT=1`.
- Non-TTY hard-throws (copying a credential is interactive-only — no automation path).

End-to-end (manual; watch `~/.agentbox/logs/latest.log`):
1. `create --provider e2b --with-credentials -n indep` against `../agentbox-test-repo-gh`
   (HTTPS+gh) — confirm the security prompt lists the token source, approve.
2. **Simulate PC off:** `agentbox relay stop`. In the box, `git push`; verify via ground truth
   (`git ls-remote` shows the new commit — exit codes are unreliable on cloud shells).
3. Repeat with `../agentbox-test-repo` (SSH remote) for the key-copy path; verify a signed commit
   (`git log --show-signature`) if a signing key was copied.
4. `gh pr create` from the box with the relay still stopped → PR opens.
5. Relay stopped: `agentbox cp` / `download` / `checkpoint` → clear "needs your PC on" error.
6. Pause/resume (`stop`/`start`) → creds survive; `git push` still works.
7. `--provider docker --with-credentials` → rejected with a clear "not applicable to docker" error.

Docs: `apps/web/content/docs/**` git/push-mode + a new "independent boxes / `--with-credentials`"
page, the CLI reference for `--with-credentials`, `git.pushMode` config docs, and
`docs/features.md`.

## Critical files

- `packages/config/src/types.ts` — `GitPushMode` + `git.pushMode` descriptor (~41, ~864).
- `apps/cli/src/lib/git-creds-gate.ts` (new); `apps/cli/src/carry-prompt.ts` /
  `apps/cli/src/lib/carry-gate.ts` (templates), wired into `apps/cli/src/commands/create.ts`
  (and the launchers) alongside the carry gate (`create.ts:301-320`).
- `apps/cli/src/commands/{create,claude,codex,opencode}.ts` — `--with-credentials` flags.
- `packages/sandbox-cloud/src/bootstrap-launch.ts` (~133) — `AGENTBOX_GIT_DIRECT` / `GH_TOKEN`.
- `packages/sandbox-cloud/src/sync/git-identity.ts` — credential helper + signing config.
- `packages/ctl/src/commands/git.ts` (push ~180, fetch ~201, pull ~223) + the gh path.
- `packages/core/src/box-record.ts` / `provider.ts` — persist push mode + copied-cred audit.
- Reused as-is: `packages/sandbox-cloud/src/sync/carry.ts` (`uploadCarryPaths`),
  `packages/core/src/provider.ts` `ResolvedCarryEntry`.
