# AgentBox test plan

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). For the feature surface this exercises, see [`features.md`](./features.md).

A regression checklist that an AI (or human) can drive end-to-end to declare AgentBox healthy for a given provider. Each entry lists the **exact command** to run, a **machine-checkable signal** for success, and a one-sentence **note** on what the check is really proving.

## How to use this plan

**Pick a provider** (`docker`, `daytona`, or `hetzner`) and walk the document top-to-bottom. Tests are tagged with provider labels — `[docker]`, `[daytona]`, `[hetzner]`, or `[all]`. Skip anything that doesn't apply to the provider under test.

**Prereqs per provider:**
- `[docker]`: Docker Desktop / OrbStack running. No login required.
- `[daytona]`: `agentbox daytona login` succeeded (`~/.agentbox/secrets.env` has `DAYTONA_API_KEY` + `DAYTONA_ORGANIZATION_ID`).
- `[hetzner]`: `agentbox hetzner login` succeeded (`HCLOUD_TOKEN` set) AND `agentbox prepare --provider hetzner` has completed (`~/.agentbox/hetzner-prepared.json` exists).

**Log files.** Every long-running command tees to `~/.agentbox/logs/<cmd>.log`, with the previous run rotated to `<cmd>.log.prev`. `~/.agentbox/logs/latest.log` always points to the most recent run. Don't pick a blind long timeout — start the command in the background and `tail -f` the log until the BEGIN/END marker for the step you care about (see [CLAUDE.md §Testing / verifying](../CLAUDE.md)).

**TUI tests.** Interactive commands (`dashboard`, `claude`, `codex`, `opencode`, `shell`) are driven through the `pnpm drive` PTY harness — see [`apps/cli/test/_harness/README.md`](../apps/cli/test/_harness/README.md).

**CLI invocation.** Tests assume a built workspace (`pnpm -w build`) and invoke the CLI as `node apps/cli/dist/index.js <cmd>` so the path is unambiguous. After `npm i -g @madarco/agentbox`, the same calls work as `agentbox <cmd>`.

**Per-test entry format:**

````markdown
- [ ] **CREATE-001** Short description.
  - **Providers:** [docker]
  - **Run:** the exact command(s), with log paths.
  - **Signal:** exit code, JSON field, substring in log, or file existence.
  - **Note:** one sentence on why this matters.
````

**Status of this document.** Tests prefixed `EXPECTED-FAIL` mark known gaps tracked in the backlog docs — see §[Deferred / known gaps](#deferred--known-gaps). Don't open bugs on those without checking the backlog first.

---

## 0. Bootstrap (run once per release)

- [ ] **BOOT-001** Fresh npm-global install works.
  - **Providers:** [all]
  - **Run:** in a clean container or a host without agentbox: `npm i -g @madarco/agentbox && agentbox --version`.
  - **Signal:** exit 0; version string matches `package.json`.
  - **Note:** Catches missing files in the published tarball (forgetting to ship `dist/`, missing bin shim, broken `postinstall`). Use the Anthropic-canonical install path conventions when packaging Claude Code into the image — see memory note `feedback_anthropic_canonical_install`.

- [ ] **BOOT-002** First run shows help when no args provided.
  - **Providers:** [all]
  - **Run:** `agentbox` (no subcommand).
  - **Signal:** exit 0; usage text lists all top-level commands.
  - **Note:** commander wiring sanity.

- [ ] **BOOT-003** Build from source.
  - **Providers:** [all]
  - **Run:** `pnpm install && pnpm -w build`.
  - **Signal:** exit 0; `apps/cli/dist/index.js` exists; `node apps/cli/dist/index.js --version` works.
  - **Note:** Catches tsup/TypeScript regressions before any runtime work.

- [ ] **BOOT-004** Lint + unit tests green.
  - **Providers:** [all]
  - **Run:** `pnpm lint && pnpm test`.
  - **Signal:** both exit 0.
  - **Note:** Baseline before regression sweep. Unit tests are pure (no docker, no network).

---

## 1. Commands (alphabetical)

### agentbox checkpoint / checkpoints

- [ ] **CKPT-001** `checkpoint create` captures a running box.
  - **Providers:** [all]
  - **Run:** with a `smoke` box already running: `node apps/cli/dist/index.js checkpoint create smoke --name s1 --replace`.
  - **Signal:** exit 0; `node apps/cli/dist/index.js checkpoint | grep -q s1`; manifest exists at `~/.agentbox/checkpoints/<hash>/s1/manifest.json` (docker) or `~/.agentbox/cloud-checkpoints/<provider>/<hash-mnemonic>/s1/manifest.json` (cloud).
  - **Note:** Cross-provider checkpoint capture works.

- [ ] **CKPT-002** `checkpoint ls` (default subcommand) lists project checkpoints.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js checkpoint`.
  - **Signal:** exit 0; output includes the checkpoint created in CKPT-001 with provider tag.
  - **Note:** Default subcommand routes to `ls`.

- [ ] **CKPT-003** `checkpoint set-default` pins a project default.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js checkpoint set-default s1` then `node apps/cli/dist/index.js config get box.defaultCheckpoint`.
  - **Signal:** config value is `s1`.
  - **Note:** Subsequent `create` (no `--snapshot`) should boot from `s1`.

- [ ] **CKPT-004** `checkpoint set-default --provider docker` writes the per-provider key only.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js checkpoint set-default s1 --provider docker` then `config get box.defaultCheckpointDocker`.
  - **Signal:** value is `s1`; cross-provider `box.defaultCheckpoint` unchanged.
  - **Note:** Per-provider default keys (`defaultCheckpointDocker` / `defaultCheckpointDaytona` / `defaultCheckpointHetzner`) shouldn't bleed across providers.

- [ ] **CKPT-005** `checkpoint set-default --clear` removes default.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js checkpoint set-default --clear` then `config get box.defaultCheckpoint`.
  - **Signal:** key is unset (exit 1 or empty).
  - **Note:** Roundtrip.

- [ ] **CKPT-006** `checkpoint rm` deletes a checkpoint.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js checkpoint rm s1 -y`.
  - **Signal:** exit 0; `checkpoint ls` no longer lists `s1`; manifest dir gone; on docker the image tag `agentbox-ckpt-<hash>:s1` no longer exists (`docker images | grep agentbox-ckpt-`).
  - **Note:** Cleanup actually frees resources.

- [ ] **CKPT-007** `checkpoint create --merged` flattens layers (docker).
  - **Providers:** [docker]
  - **Run:** `node apps/cli/dist/index.js checkpoint create smoke --name flat --merged --replace`; inspect with `docker history agentbox-ckpt-<hash>:flat`.
  - **Signal:** image has a single `FROM scratch ADD rootfs.tar` layer (no parent chain).
  - **Note:** Manual flatten path; check the lineage actually collapses.

- [ ] **CKPT-008** Layer auto-flatten triggers at threshold (docker).
  - **Providers:** [docker]
  - **Run:** create base box, then `checkpoint create` 3 times in a row with different names. Inspect `docker history` of the third image.
  - **Signal:** third image has parents `[]` (auto-flattened); manifests record `flattened: true`.
  - **Note:** Auto-flatten kicks in at the configured threshold (≥3 layers) so checkpoint chains don't accumulate.

- [ ] **CKPT-009** Checkpoint isolation across providers.
  - **Providers:** [all] (cross-provider)
  - **Run:** with both docker and a cloud provider configured, in same project: `checkpoint create <docker-box> --name setup`; `checkpoint create <cloud-box> --name setup`; `checkpoint`.
  - **Signal:** both checkpoints listed independently with their provider tag; neither overwrote the other.
  - **Note:** Project default key + checkpoint name don't collide across providers.

---

### agentbox claude

- [ ] **CLAUDE-001** `claude` creates a box and launches Claude session.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js claude -y -n claude-smoke &` then `tail -f ~/.agentbox/logs/claude.log` until "session ready" / Claude TUI marker.
  - **Signal:** exit code only after detach; `agentbox ls -j | jq '.[] | select(.name=="claude-smoke") | .state'` returns `"running"`; tmux session present in box.
  - **Note:** End-to-end create + agent attach happy path.

- [ ] **CLAUDE-002** `claude attach` reattaches to a running session.
  - **Providers:** [all]
  - **Run:** `pnpm drive start --name claude -- node apps/cli/dist/index.js claude attach claude-smoke` then `pnpm drive wait claude --text "claude" --timeout 15000`.
  - **Signal:** screen shows Claude TUI; sending `<C-a>d` cleanly detaches without killing the session.
  - **Note:** Tmux reattach works without spawning a duplicate.

- [ ] **CLAUDE-003** `claude start` resumes a stopped/paused box and launches session.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js stop claude-smoke` then `node apps/cli/dist/index.js claude start claude-smoke`.
  - **Signal:** box transitions stopped → running; session reattaches.
  - **Note:** `start` subcommand wraps unpause/start + session relaunch.

- [ ] **CLAUDE-004** `claude login` rotates Claude credentials in the box.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js claude login claude-smoke --force` and complete the OAuth flow inside the box.
  - **Signal:** `~/.claude/.credentials.json` inside the box updated; next `claude attach` doesn't prompt re-auth.
  - **Note:** Force re-auth path.

- [ ] **CLAUDE-005** `--isolate-claude-config` gives box its own credentials volume.
  - **Providers:** [docker]
  - **Run:** `node apps/cli/dist/index.js claude -y -n iso --isolate-claude-config` and check the mounted volume.
  - **Signal:** `docker inspect agentbox-iso | jq '.[0].Mounts'` shows a per-box claude volume, not the shared `agentbox-claude-config`.
  - **Note:** Per-box auth isolation works for users running multiple Claude accounts.

---

### agentbox code

- [ ] **CODE-001** `code` opens box in VS Code / Cursor.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js code <box-id> --print`.
  - **Signal:** stdout prints `vscode-remote://...` or `cursor://` URI pointing at `/workspace` in the box.
  - **Note:** Dev Containers URI is well-formed; we don't actually need to spawn the IDE in CI.

- [ ] **CODE-002** `code --regen-tasks` overwrites tasks.json.
  - **Providers:** [all]
  - **Run:** edit `.vscode/tasks.json` in box, then `code <box> --regen-tasks --no-wait --print`.
  - **Signal:** `.vscode/tasks.json` reset to autogenerated content with all services from `agentbox.yaml` listed.
  - **Note:** Regen path doesn't clobber unrelated files.

---

### agentbox codex

- [ ] **CODEX-001** `codex` creates a box and launches Codex session.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js codex -y -n codex-smoke &` then `tail -f ~/.agentbox/logs/codex.log` until ready.
  - **Signal:** box `running`, tmux session present, Codex TUI alive via `pnpm drive`.
  - **Note:** Codex parity with the Claude flow.

- [ ] **CODEX-002** `codex attach` / `codex start` / `codex login` mirror Claude subcommands.
  - **Providers:** [all]
  - **Run:** same as CLAUDE-002 through CLAUDE-004 substituting `codex`.
  - **Signal:** see CLAUDE-002/3/4.
  - **Note:** Verify all four subcommands not just `codex` itself.

---

### agentbox config

- [ ] **CFG-001** `config get` returns effective value (project > global).
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js config get box.provider`.
  - **Signal:** exit 0; prints `docker` (or whatever project layer sets).
  - **Note:** Effective layer resolution works.

- [ ] **CFG-002** `config get --all` shows every layer with source.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js config get box.provider --all --json`.
  - **Signal:** JSON includes entries for `global`, `project`, `workspace` with file paths.
  - **Note:** Layer transparency for debugging.

- [ ] **CFG-003** `config set --global` persists to `~/.agentbox/config.yaml`.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js config set box.someKey hello --global`; inspect file.
  - **Signal:** file contains `box.someKey: hello`.
  - **Note:** Global writes survive cd.

- [ ] **CFG-004** `config unset` removes a key.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js config unset box.someKey --global`.
  - **Signal:** key absent from `config get --all`.

- [ ] **CFG-005** `config list-projects` enumerates configured projects.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js config list-projects --json`.
  - **Signal:** every project that has ever had a box appears with its root path.
  - **Note:** Project index is in sync with `~/.agentbox/state.json`.

- [ ] **CFG-006** `config path` prints the right file for each scope.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js config path --global`; same with `--project`, `--workspace`.
  - **Signal:** prints valid paths under `~/.agentbox/`, the project's `.agentbox/`, and `/workspace/.agentbox/` respectively.

- [ ] **CFG-007** `config edit` spawns `$EDITOR`.
  - **Providers:** [all]
  - **Run:** `EDITOR=true node apps/cli/dist/index.js config edit --global` (using `true` as no-op editor).
  - **Signal:** exit 0; no file changes.

---

### agentbox cp

- [ ] **CP-001** `cp` uploads a host file into box.
  - **Providers:** [all]
  - **Run:** `echo hello > /tmp/file.txt && node apps/cli/dist/index.js cp /tmp/file.txt smoke:/workspace/file.txt`; verify with `node apps/cli/dist/index.js shell smoke -- cat /workspace/file.txt`.
  - **Signal:** content matches.
  - **Note:** Host → box transfer works for docker (`docker cp`), daytona (relay download), hetzner (scp).

- [ ] **CP-002** `cp` downloads a box file to host.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js cp smoke:/workspace/file.txt /tmp/out.txt`.
  - **Signal:** `cat /tmp/out.txt` matches what was uploaded.

- [ ] **CP-003** `cp` uploads a directory recursively.
  - **Providers:** [all]
  - **Run:** create `/tmp/dir` with 3 files; `cp /tmp/dir smoke:/workspace/`.
  - **Signal:** `shell smoke -- ls /workspace/dir` lists all 3.
  - **Note:** Directory uploads aren't truncated to top-level files.

---

### agentbox create

- [ ] **CREATE-001** `create` (defaults) spins up a box.
  - **Providers:** [docker] (default provider)
  - **Run:** `node apps/cli/dist/index.js create -y -n smoke &` then `tail -f ~/.agentbox/logs/create.log` until you see the box-ready marker (look for the END marker of the final step).
  - **Signal:** exit 0; `agentbox ls -j | jq '.[] | select(.name=="smoke") | .state'` returns `"running"`; `agentbox status smoke -j` shows autostart units ready.
  - **Note:** Default lifecycle — auto-build image if missing, seed worktree against bind-mounted `.git/`, launch supervisor, autostart services ready.

- [ ] **CREATE-002** `create --provider daytona` provisions a cloud sandbox.
  - **Providers:** [daytona]
  - **Run:** `node apps/cli/dist/index.js create --provider daytona -y -n cloud-smoke &` and tail the log.
  - **Signal:** exit 0; box reachable via `agentbox shell cloud-smoke -- pwd` returning `/workspace`; preview URL minted (`url --print` returns a `*.proxy.daytona.work` URL).
  - **Note:** End-to-end create on Daytona using bundle + stash + untracked seeding.

- [ ] **CREATE-003** `create --provider hetzner` provisions a VPS.
  - **Providers:** [hetzner]
  - **Run:** `node apps/cli/dist/index.js create --provider hetzner -y -n h-smoke &` and tail the log.
  - **Signal:** exit 0; per-box SSH key minted at `~/.agentbox/boxes/<id>/ssh/id_ed25519`; firewall created and locked to host's egress IP (`agentbox hetzner firewall show h-smoke`); shell works.
  - **Note:** VPS provisioning + per-box SSH + firewall lockdown all together.

- [ ] **CREATE-004** `create --snapshot <ref>` starts from a checkpoint.
  - **Providers:** [all]
  - **Run:** with a checkpoint `s1` existing: `node apps/cli/dist/index.js create -y -n restored --snapshot s1`.
  - **Signal:** create completes faster (no workspace seeding step appears in log for docker; cloud still seeds workspace); files captured in the checkpoint are present.
  - **Note:** Checkpoint restore path. **Caveat:** on cloud, workspace files are always re-seeded from the host bundle even from a checkpoint — only OS/tool state comes from the snapshot.

- [ ] **CREATE-005** `create --image <ref>` overrides the box base image.
  - **Providers:** [docker]
  - **Run:** `create -y -n custom --image agentbox/box:dev`.
  - **Signal:** box created from the specified image (`docker inspect agentbox-custom | jq .Config.Image`).

- [ ] **CREATE-006** `create --host-snapshot` uses APFS clone for stable seeding.
  - **Providers:** [docker]
  - **Run:** `create -y -n hs --host-snapshot`; during create, modify a file in host workspace; check box contents after create finishes.
  - **Signal:** box has pre-modification content (snapshot froze bytes).
  - **Note:** APFS clone freezes the source so concurrent host edits don't race the tar-pipe.

- [ ] **CREATE-007** `create --with-playwright` installs Playwright in the box.
  - **Providers:** [all]
  - **Run:** `create -y -n pw --with-playwright`; verify `agentbox shell pw -- npx playwright --version`.
  - **Signal:** prints a Playwright version string.

- [ ] **CREATE-008** `create --with-env` copies host env files into /workspace.
  - **Providers:** [all]
  - **Run:** put a `.env.local` in host workspace; `create -y -n env --with-env`; verify `agentbox shell env -- cat /workspace/.env.local`.
  - **Signal:** content matches.
  - **Note:** Mirror of `agentbox download env` in reverse.

- [ ] **CREATE-009** `create --memory --cpus --pids-limit` apply resource caps.
  - **Providers:** [docker]
  - **Run:** `create -y -n caps --memory 512m --cpus 1 --pids-limit 256`; `agentbox status caps --inspect`.
  - **Signal:** caps reflected in inspect output and visible in `docker inspect`.

- [ ] **CREATE-010** Dirty workspace state (staged + untracked) survives seeding.
  - **Providers:** [all]
  - **Run:** in host workspace, edit a tracked file (don't commit), create a new untracked file, then `create -y -n dirty`.
  - **Signal:** both files appear inside `/workspace` of new box with the host's exact content.
  - **Note:** Stash + untracked tar carry-over works across providers.

- [ ] **CREATE-011** Hetzner: egress IP detection failure is loud, not silent.
  - **Providers:** [hetzner]
  - **Run:** block outbound to `api.ipify.org`, `ifconfig.io`, `icanhazip.com` (e.g. `/etc/hosts` 127.0.0.1 mapping); `create --provider hetzner -y -n fail`.
  - **Signal:** create fails with an explicit "refusing to set 0.0.0.0/0" / "egress IP detection failed" error; no VPS created.
  - **Note:** Safe-by-default — never open the box to the world (memory note `feedback-cloud-providers-safe-defaults`).

- [ ] **CREATE-012** Daytona: 504 from edge proxy retried, not propagated.
  - **Providers:** [daytona]
  - **Run:** in a fault-injected environment, return one 504 from the bridge poller; observe `~/.agentbox/logs/create.log`.
  - **Signal:** retry wrapper absorbs up to 3 attempts; create still succeeds.
  - **Note:** Edge-proxy intermittent failures shouldn't break create. *(Manual fault injection required; skip if unable.)*

- [ ] **CREATE-013** `carry:` block + `--carry-yes` copies host files into the box at declared destinations.
  - **Providers:** [docker, hetzner, daytona]
  - **Setup:** `mkdir -p ~/.agentbox/carry-smoke && echo marker > ~/.agentbox/carry-smoke/m.txt && mkdir -p /tmp/cbtest && cat > /tmp/cbtest/agentbox.yaml <<'EOF'
carry:
  - src: ~/.agentbox/carry-smoke/m.txt
    dest: ~/carried.txt
    mode: 0o600
EOF`
  - **Run:** `node apps/cli/dist/index.js create -w /tmp/cbtest -y -n carry-smoke --carry-yes`.
  - **Signal:** `agentbox shell carry-smoke -- stat -c '%a %U:%G %n' /home/vscode/carried.txt` returns `600 vscode:vscode /home/vscode/carried.txt`; `agentbox shell carry-smoke -- cat /home/vscode/carried.txt` returns `marker`; `~/.agentbox/state.json` shows `carry: {count:1, entries:[…]}` on the BoxRecord.

- [ ] **CREATE-014** `carry:` + `AGENTBOX_CARRY=skip` creates the box but copies nothing.
  - **Providers:** [docker]
  - **Run:** with the CREATE-013 yaml: `AGENTBOX_CARRY=skip node apps/cli/dist/index.js create -w /tmp/cbtest -y -n carry-skip`.
  - **Signal:** `agentbox shell carry-skip -- ls /home/vscode/carried.txt` returns "No such file"; create.log contains `carry: skipped for this box`.

- [ ] **CREATE-015** `carry:` + `-y` on non-TTY without opt-in fails loud (CI safety).
  - **Providers:** [docker]
  - **Run:** with the CREATE-013 yaml: `node apps/cli/dist/index.js create -w /tmp/cbtest -y -n carry-fail </dev/null`.
  - **Signal:** exits non-zero with `carry: requires approval but stdin is not a TTY and --carry-yes was not set. … set AGENTBOX_CARRY_YES=1 … or AGENTBOX_CARRY=skip`. No container created.
  - **Note:** Prevents silent exfiltration of `~/.agentbox/secrets.env` from shared CI runners.

- [ ] **CREATE-016** `carry:` resolver rejects denylisted dests and `..` traversal at parse time.
  - **Providers:** [docker]
  - **Run:** stage a yaml with `carry: [{src: ~/something.txt, dest: /etc/passwd}]`; `agentbox create -w /tmp/cbtest -y --carry-yes` (also try `dest: ~/../etc/passwd`).
  - **Signal:** create fails with `carry: refused to proceed:` + the specific denylist / `..` error; no container started.

---

### agentbox daytona

- [ ] **DAYTONA-001** `daytona login --status` (no token configured) reports missing.
  - **Providers:** [daytona]
  - **Run:** with `~/.agentbox/secrets.env` cleared of Daytona keys: `node apps/cli/dist/index.js daytona login --status`.
  - **Signal:** prints "not configured" / exit non-zero.

- [ ] **DAYTONA-002** `daytona login` (non-interactive via env) persists token.
  - **Providers:** [daytona]
  - **Run:** `DAYTONA_API_KEY=xxx node apps/cli/dist/index.js daytona login`.
  - **Signal:** `~/.agentbox/secrets.env` contains the masked key; `daytona login --status` confirms.

- [ ] **DAYTONA-003** `daytona resync` re-uploads agent credentials to shared volume.
  - **Providers:** [daytona]
  - **Run:** modify host `~/.claude/.credentials.json`, then `node apps/cli/dist/index.js daytona resync -a claude`.
  - **Signal:** next `create --provider daytona` boxes see the updated credentials.
  - **Note:** Credential change detection without snapshot republish (memory note `feedback-credential-change-detection`).

---

### agentbox dashboard

> Driven through `pnpm drive`. All commands assume `pnpm -w build` already ran.

- [ ] **DASH-001** Dashboard launches and shows sidebar.
  - **Providers:** [all] (boxes from any provider should appear)
  - **Run:** `pnpm drive start --name dash -- node apps/cli/dist/index.js dashboard`; `pnpm drive wait dash --text "AgentBox" --timeout 5000`; `pnpm drive screen dash`.
  - **Signal:** Screen contains a sidebar listing boxes grouped by project + `+ New box` entry at top + footer chord menu hint.

- [ ] **DASH-002** Ctrl-a leader chord menu shows.
  - **Providers:** [all]
  - **Run:** `pnpm drive send dash "<C-a>"` then immediately `pnpm drive screen dash`.
  - **Signal:** Footer expands to show full chord menu (`[c] Claude [x] Codex [o] OpenCode [s] Shell [u] URL [t] Stop [p] Pause [d] Destroy [q] Quit`).
  - **Note:** Leader-key TUI navigation works.

- [ ] **DASH-003** Ctrl-a then q quits dashboard cleanly.
  - **Providers:** [all]
  - **Run:** `pnpm drive send dash "<C-a>q"`; `pnpm drive list`.
  - **Signal:** Session no longer present; terminal restored (no leftover alt-screen).

- [ ] **DASH-004** Ctrl+Opt+Down switches to next box in sidebar.
  - **Providers:** [all] (needs ≥2 boxes)
  - **Run:** boot dashboard with 2+ boxes; send the escape sequence for Ctrl+Option+Down (`\x1b[1;7B`); `screen dash`.
  - **Signal:** `▸` selection marker advances to next box.

- [ ] **DASH-005** Running box with no agent session shows menu.
  - **Providers:** [all]
  - **Run:** select a running box with no tmux sessions; `screen dash`.
  - **Signal:** Right pane shows menu: `[c] Claude [x] Codex [o] OpenCode [s] Shell`.

- [ ] **DASH-006** Running box with active Claude session auto-attaches.
  - **Providers:** [all]
  - **Run:** select a box that has Claude running.
  - **Signal:** Right pane shows live Claude PTY (Claude's prompt visible).

- [ ] **DASH-007** Paused box shows lifecycle menu.
  - **Providers:** [docker], [daytona]
  - **Run:** pause a box, select it in dashboard.
  - **Signal:** Right pane shows `[u] Unpause [d] Destroy`.

- [ ] **DASH-008** Stopped box shows lifecycle menu with Start.
  - **Providers:** [all]
  - **Run:** stop a box, select it.
  - **Signal:** Right pane shows `[s] Start [d] Destroy` (not `[u] Unpause`).

- [ ] **DASH-009** Destroy two-step confirm.
  - **Providers:** [all]
  - **Run:** in lifecycle menu, press `d`, then `y` to confirm.
  - **Signal:** Box destroyed; sidebar updates.

- [ ] **DASH-010** `+ New box` opens create wizard.
  - **Providers:** [all]
  - **Run:** select `+ New box` (top of sidebar); `screen dash`.
  - **Signal:** Agent-choice menu visible (None / Claude / Codex / OpenCode).

- [ ] **DASH-011** Sidebar shows prompt glyph when relay prompt pending.
  - **Providers:** [all]
  - **Run:** from inside a box: `agentbox-ctl git push origin agentbox/<box>` (no auto-approve); refresh dashboard.
  - **Signal:** sidebar row marked with `▲ prompt`.

- [ ] **DASH-012** Sidebar shows checkpoint glyph during freeze.
  - **Providers:** [docker]
  - **Run:** start a long-running `checkpoint create` on a box; refresh dashboard.
  - **Signal:** sidebar row marked with `◆ checkpoint`.

---

### agentbox destroy / rm

- [ ] **DESTROY-001** `destroy -y` removes container/VPS and per-box volumes.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js destroy smoke -y`.
  - **Signal:** exit 0; box absent from `agentbox ls`; on docker: `docker ps -a | grep agentbox-smoke` empty AND per-box volumes (`agentbox-smoke`, `agentbox-vscode-server-smoke`, etc.) gone; on hetzner: server, firewall, per-box SSH key dir under `~/.agentbox/boxes/<id>/ssh/` gone.
  - **Note:** Full cleanup, no orphans.

- [ ] **DESTROY-002** `destroy --keep-snapshot` preserves checkpoints.
  - **Providers:** [all]
  - **Run:** `checkpoint create smoke --name keep` then `destroy smoke -y --keep-snapshot`.
  - **Signal:** checkpoint still listed by `agentbox checkpoint`.
  - **Note:** Useful when destroying a box but you want to start from its snapshot later.

- [ ] **DESTROY-003** `rm` alias works.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js rm <box> -y`.
  - **Signal:** identical behavior to `destroy`.

---

### agentbox download

- [ ] **DL-001** `download` pulls /workspace back to host.
  - **Providers:** [all]
  - **Run:** in box, create `/workspace/new-file.txt`; on host `node apps/cli/dist/index.js download smoke -y --dry-run` then without `--dry-run`.
  - **Signal:** dry-run lists `new-file.txt`; real run writes it to host workspace.

- [ ] **DL-002** `download --no-respect-gitignore` includes ignored files.
  - **Providers:** [all]
  - **Run:** in box, create `/workspace/secret.env` (gitignored); `download smoke --no-respect-gitignore -y`.
  - **Signal:** file appears on host.

- [ ] **DL-003** `download env [box]` copies env files only.
  - **Providers:** [docker]
  - **Run:** `download env smoke -y`.
  - **Signal:** `.env*`, `.envrc`, etc. files copied; other files untouched.

- [ ] **DL-004** `download claude [box]` copies Claude skills/plugins/config.
  - **Providers:** [docker]
  - **Run:** `download claude smoke`.
  - **Signal:** host `~/.claude/skills/...` and config updated.

- [ ] **DL-005** `download config [box]` copies agentbox.yaml.
  - **Providers:** [all]
  - **Run:** edit `/workspace/agentbox.yaml` in box; `download config smoke -y`.
  - **Signal:** host `agentbox.yaml` matches.

- [ ] **EXPECTED-FAIL-DL-006** Cloud: `download env / config / claude / codex / opencode` not yet routed.
  - **Providers:** [daytona], [hetzner]
  - **Note:** Tracked in `daytona-backlog.md` / `hertzner_backlog.md` — volume-backed source paths missing.

---

### agentbox hetzner

- [ ] **HET-001** `hetzner login --status` (no token) reports missing.
  - **Providers:** [hetzner]
  - **Run:** clear `HCLOUD_TOKEN` from `~/.agentbox/secrets.env`; `node apps/cli/dist/index.js hetzner login --status`.
  - **Signal:** non-zero exit; "not configured".

- [ ] **HET-002** `hetzner login` validates token by hitting `/locations`.
  - **Providers:** [hetzner]
  - **Run:** `HCLOUD_TOKEN=bogus node apps/cli/dist/index.js hetzner login`.
  - **Signal:** error mentions auth failure; token NOT written to `secrets.env`.

- [ ] **HET-003** `hetzner firewall show <box>` prints rules + current egress IP.
  - **Providers:** [hetzner]
  - **Run:** `node apps/cli/dist/index.js hetzner firewall show h-smoke`.
  - **Signal:** output includes detected egress IP and an inbound SSH /32 rule matching it.

- [ ] **HET-004** `hetzner firewall sync <box>` re-locks after network change.
  - **Providers:** [hetzner]
  - **Run:** with a box created from IP A, simulate IP change (override `AGENTBOX_HETZNER_FIREWALL_SOURCE=1.2.3.4/32`); `hetzner firewall sync h-smoke`.
  - **Signal:** firewall now lists 1.2.3.4/32; `hetzner firewall show` confirms.
  - **Note:** Recovery from "I moved networks and SSH times out".

- [ ] **EXPECTED-FAIL-HET-005** `agentbox prune --provider hetzner` not wired.
  - **Providers:** [hetzner]
  - **Note:** Tracked in `hertzner_backlog.md`; `backend.list()` works but CLI dispatcher case missing.

---

### agentbox list / ls

- [ ] **LS-001** `ls` lists project boxes.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js ls`.
  - **Signal:** tabular output with name, state, provider columns.

- [ ] **LS-002** `ls -g` lists boxes across all projects.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js ls -g`.
  - **Signal:** boxes from at least one other project appear (if you have them).

- [ ] **LS-003** `ls -j` emits machine-readable JSON.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js ls -j | jq '.[0] | keys'`.
  - **Signal:** keys include `id`, `name`, `state`, `provider`, `projectRoot`.

---

### agentbox logs

- [ ] **LOGS-001** `logs <box> <service>` prints recent service output.
  - **Providers:** [all]
  - **Run:** with a service `web` defined: `node apps/cli/dist/index.js logs smoke web --tail 50`.
  - **Signal:** last 50 lines of the service's stdout/stderr.

- [ ] **LOGS-002** `logs -f` streams in real time.
  - **Providers:** [all]
  - **Run:** `logs smoke web -f &`, then trigger output inside the box.
  - **Signal:** new lines appear on host stdout within ~1s.

- [ ] **LOGS-003** `logs --daemon` tails the ctl daemon log.
  - **Providers:** [all]
  - **Run:** `logs smoke --daemon`.
  - **Signal:** output is the in-box `agentbox-ctl` daemon's own log.

---

### agentbox opencode

- [ ] **OPENCODE-001..004** Mirror Claude/Codex (create, attach, start, login).
  - **Providers:** [all]
  - **Run:** substitute `opencode` in CLAUDE-001..004.
  - **Signal:** see CLAUDE-001..004.

---

### agentbox open

- [ ] **OPEN-001** `open --path` prints local sshfs/rsync mount path.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js open smoke --path`.
  - **Signal:** prints absolute path; path exists.

- [ ] **OPEN-002** `open --unmount` releases sshfs mount (cloud).
  - **Providers:** [daytona], [hetzner]
  - **Run:** `open smoke` then `open smoke --unmount`.
  - **Signal:** mount gone (`mount | grep sshfs` empty for this box).

---

### agentbox pause / unpause

- [ ] **PAUSE-001** `pause` freezes a docker box at cgroup level.
  - **Providers:** [docker]
  - **Run:** `node apps/cli/dist/index.js pause smoke`; `docker inspect agentbox-smoke | jq '.[0].State.Status'`.
  - **Signal:** state is `paused`; CPU usage 0 in `agentbox top --once`.

- [ ] **PAUSE-002** `unpause` resumes paused box with warm cache.
  - **Providers:** [docker]
  - **Run:** `node apps/cli/dist/index.js unpause smoke`; immediately `agentbox shell smoke -- date`.
  - **Signal:** shell responds within ~1s (no full restart).

- [ ] **PAUSE-003** Cloud pause = archive (daytona) or poweroff (hetzner).
  - **Providers:** [daytona], [hetzner]
  - **Run:** `pause smoke` then `unpause smoke`; time the resume.
  - **Signal:** resume takes seconds (daytona archive restore) or ~30s (hetzner power on); state transitions visible in `ls`.
  - **Note:** Cloud "pause" is not zero-cost like docker — daytona keeps storage charges, hetzner keeps VPS €.

---

### agentbox prepare

- [ ] **PREP-001** `prepare` builds local docker image.
  - **Providers:** [docker]
  - **Run:** `docker rmi agentbox/box:dev` (if present); `node apps/cli/dist/index.js prepare`.
  - **Signal:** exit 0; `docker images | grep agentbox/box` lists `dev` tag.

- [ ] **PREP-002** `prepare` skip-fast when image already exists.
  - **Providers:** [docker]
  - **Run:** rerun `prepare` immediately after PREP-001.
  - **Signal:** exit 0 in seconds; log says "image exists, skipping".

- [ ] **PREP-003** `prepare --force` rebuilds.
  - **Providers:** [docker]
  - **Run:** `prepare --force`.
  - **Signal:** Dockerfile rebuild runs (look for `Step N/M` markers).

- [ ] **PREP-004** `prepare --provider daytona` publishes a snapshot.
  - **Providers:** [daytona]
  - **Run:** `node apps/cli/dist/index.js prepare --provider daytona --name agentbox-base-v1 -y`.
  - **Signal:** Daytona snapshot named `agentbox-base-v1` listed; command prints config-set hint for `box.image`.

- [ ] **PREP-005** `prepare --provider hetzner` creates base snapshot + records it.
  - **Providers:** [hetzner]
  - **Run:** `node apps/cli/dist/index.js prepare --provider hetzner -y`.
  - **Signal:** exit 0; `~/.agentbox/hetzner-prepared.json` written with `{base.imageId, installScriptSha256}`; ephemeral VPS gone (`curl -s https://api.hetzner.cloud/v1/servers ...` returns no `agentbox-prep-*` server).

- [ ] **PREP-006** `prepare --status` reports without modifying.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js prepare --provider hetzner --status`.
  - **Signal:** prints "prepared: <imageId>" or "not prepared"; no API calls beyond GET.

- [ ] **PREP-007** Hetzner prepare cleanup on mid-install failure.
  - **Providers:** [hetzner]
  - **Run:** simulate install failure (e.g. `HCLOUD_TOKEN` revoked mid-run, or kill the `install-box.sh` SSH process).
  - **Signal:** subsequent run does not see orphaned `agentbox-prep-*` VPS/firewall on Hetzner; if cleanup itself fails, log includes "check Hetzner dashboard manually" hint.

---

### agentbox prune

- [ ] **PRUNE-001** `prune --dry-run` lists candidates without deletion.
  - **Providers:** [docker]
  - **Run:** manually create an orphan (`docker run --name agentbox-orphan agentbox/box:dev sleep 5`) then `node apps/cli/dist/index.js prune --all --dry-run`.
  - **Signal:** lists `agentbox-orphan`; nothing deleted.

- [ ] **PRUNE-002** `prune --all -y` removes orphans.
  - **Providers:** [docker]
  - **Run:** `node apps/cli/dist/index.js prune --all -y`.
  - **Signal:** orphan container/volumes/snapshots gone; `state.json` records match reality.

- [ ] **PRUNE-003** `prune --provider daytona -y` cleans cloud orphans.
  - **Providers:** [daytona]
  - **Run:** delete a sandbox via Daytona dashboard, then `prune --provider daytona -y`.
  - **Signal:** local `state.json` entry removed; remote agentbox.name-labeled sandboxes that aren't in local state get listed for removal.

- [ ] **EXPECTED-FAIL-PRUNE-004** `prune --provider hetzner` not wired (see HET-005).

---

### agentbox relay

- [ ] **RELAY-001** `relay status` reports running daemon.
  - **Providers:** [all]
  - **Run:** with at least one box: `node apps/cli/dist/index.js relay status --json`.
  - **Signal:** JSON includes `pid`, `port`, `boxCount`; `pid` corresponds to a live process.

- [ ] **RELAY-002** `relay restart` rotates the daemon cleanly.
  - **Providers:** [all]
  - **Run:** capture pid → `relay restart` → check new pid.
  - **Signal:** new pid > old pid; box registrations survive (queried via `relay status`).
  - **Note:** Rehydration of registered boxes on restart.

- [ ] **RELAY-003** `relay stop` then `relay start` are idempotent.
  - **Providers:** [all]
  - **Run:** `relay stop && relay stop && relay start && relay start`.
  - **Signal:** all four exit 0.

- [ ] **RELAY-004** `GET /healthz` is unauthenticated and 200.
  - **Providers:** [all]
  - **Run:** `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$(node apps/cli/dist/index.js relay status -j | jq -r .port)/healthz`.
  - **Signal:** `200`.

- [ ] **RELAY-005** Admin endpoints reject non-loopback (403).
  - **Providers:** [all]
  - **Run:** from a non-loopback address (e.g., another host on LAN reach), GET `/admin/box-status?box=...`.
  - **Signal:** `403`. *(If networking doesn't allow, simulate by adding a non-127 alias and binding there.)*

- [ ] **RELAY-006** `/rpc` bearer-gated.
  - **Providers:** [all]
  - **Run:** `curl -sS -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:<port>/rpc -d '{}'` (no Authorization header).
  - **Signal:** `401`.

- [ ] **RELAY-007** 1 MiB request body limit.
  - **Providers:** [all]
  - **Run:** POST a 2 MiB body to `/rpc` (with valid token).
  - **Signal:** `413`.

- [ ] **RELAY-008** `agentbox-ctl git push` (in-box) routes through host relay.
  - **Providers:** [all]
  - **Run:** from inside a box: `agentbox-ctl git push origin HEAD`; on host, ensure prompt arrives (visible in dashboard or via `/admin/prompts/stream`); approve.
  - **Signal:** host-side git push runs (verify via `~/.agentbox/logs/relay.log`); in-box exit code matches host git's; remote branch updated.
  - **Note:** Gate at host boundary (memory note `feedback-gate-at-host-boundary-not-agent`).

- [ ] **RELAY-009** `agentbox-ctl git fetch` works without box-side creds.
  - **Providers:** [all]
  - **Run:** `agentbox-ctl git fetch` inside box (no SSH key in box).
  - **Signal:** fetch succeeds; remote refs visible in `git branch -r`.

- [ ] **RELAY-010** `agentbox-ctl open <url>` opens in box browser + host confirm.
  - **Providers:** [docker]
  - **Run:** `agentbox-ctl open https://example.com` inside box.
  - **Signal:** URL appears in box's VNC Chromium; host footer (dashboard) shows confirm prompt within ~25s.

---

### agentbox screen

- [ ] **SCREEN-001** `screen --print` returns VNC URL.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js screen smoke --print`.
  - **Signal:** prints URL ending in `/vnc.html?...`; for docker uses `.localhost` (or `--loopback` for `127.0.0.1:PORT`); for cloud is signed.

- [ ] **SCREEN-002** `screen --loopback` (docker) returns 127.0.0.1 URL.
  - **Providers:** [docker]
  - **Run:** `screen smoke --print --loopback`.
  - **Signal:** URL host is `127.0.0.1:<ephemeral>`.

---

### agentbox self-update

- [ ] **UPDATE-001** `self-update --dry-run` shows plan.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js self-update --dry-run`.
  - **Signal:** lists steps: npm self-upgrade, image wipe, relay restart; nothing executed.

- [ ] **UPDATE-002** `self-update --skip-self -y` refreshes image + relay only.
  - **Providers:** [docker]
  - **Run:** `self-update --skip-self -y`.
  - **Signal:** local `agentbox/box:dev` rebuilt; relay restarted; npm step skipped.

---

### agentbox shell

- [ ] **SHELL-001** `shell <box> -- <cmd>` runs one-shot.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js shell smoke -- pwd`.
  - **Signal:** stdout is `/workspace`; exit 0.

- [ ] **SHELL-002** `shell <box>` opens interactive tmux session.
  - **Providers:** [all]
  - **Run:** `pnpm drive start --name sh -- node apps/cli/dist/index.js shell smoke`; `pnpm drive wait sh --text "$ " --timeout 10000`.
  - **Signal:** screen shows a prompt; sending `echo hello<Enter>` echoes; `<C-a>d` detaches cleanly.

- [ ] **SHELL-003** `shell --no-tmux` plain docker exec.
  - **Providers:** [docker]
  - **Run:** `pnpm drive start --name shnt -- node apps/cli/dist/index.js shell smoke --no-tmux`.
  - **Signal:** no tmux process inside box (`docker exec agentbox-smoke pgrep tmux` empty).

- [ ] **SHELL-004** `shell ls` lists tmux sessions.
  - **Providers:** [all]
  - **Run:** with a shell session named `work` open: `node apps/cli/dist/index.js shell ls smoke`.
  - **Signal:** output includes `work`.

- [ ] **SHELL-005** `shell kill <session>` removes session.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js shell kill smoke work`.
  - **Signal:** `shell ls smoke` no longer shows `work`.

---

### agentbox start / stop

- [ ] **START-001** `stop` then `start` roundtrip preserves /workspace.
  - **Providers:** [all]
  - **Run:** `echo data > /tmp/x; cp /tmp/x smoke:/workspace/x; stop smoke; start smoke; shell smoke -- cat /workspace/x`.
  - **Signal:** file content preserved.

- [ ] **START-002** `start` on already-running box is idempotent.
  - **Providers:** [all]
  - **Run:** `start smoke` twice.
  - **Signal:** both exit 0; no errors.

---

### agentbox status

- [ ] **STATUS-001** `status <box>` shows service + task states.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js status smoke -j`.
  - **Signal:** JSON has `services` and `tasks` maps with per-unit `state` and `blockedOn` keys.

- [ ] **STATUS-002** `status --inspect` shows volumes/limits/paths.
  - **Providers:** [all]
  - **Run:** `node apps/cli/dist/index.js status smoke --inspect`.
  - **Signal:** output includes per-box volume names, memory/cpu limits, workspace mount info.

---

### agentbox top

- [ ] **TOP-001** `top --once -j` returns one snapshot.
  - **Providers:** [docker]
  - **Run:** `node apps/cli/dist/index.js top --once -j`.
  - **Signal:** JSON array with cpu/mem/pids/disk for each box.

- [ ] **TOP-002** `top` cloud rows show `—` for live metrics.
  - **Providers:** [daytona], [hetzner]
  - **Run:** `top --once`.
  - **Signal:** cloud box rows show no live cpu/mem (limitation of basic API).

---

### agentbox url

- [ ] **URL-001** `url --print` returns box web URL.
  - **Providers:** [all]
  - **Run:** with `expose: { port: 3000, as: 80 }` in agentbox.yaml: `node apps/cli/dist/index.js url smoke --print`.
  - **Signal:** prints `https://smoke.localhost` (docker Portless) or signed cloud preview URL.

- [ ] **URL-002** `url --loopback` (docker) returns 127.0.0.1 URL.
  - **Providers:** [docker]
  - **Run:** `url smoke --print --loopback`.
  - **Signal:** URL host is `127.0.0.1:<ephemeral>`.

- [ ] **URL-003** Cloud `url --ttl 7200` extends signed URL expiry.
  - **Providers:** [daytona]
  - **Run:** `url smoke --print --ttl 7200`.
  - **Signal:** URL/token expires 2h out (parse JWT or test access after 1h).

- [ ] **URL-004** Symmetric Portless URLs across providers.
  - **Providers:** [all]
  - **Run:** same `box.name=portless-smoke` on docker and cloud; `url portless-smoke --print` on each.
  - **Signal:** host-side URLs identical shape (`https://portless-smoke.localhost`).
  - **Note:** Memory `feedback-symmetric-portless-urls` — Portless integration consistent across docker and cloud.

---

### agentbox wait

- [ ] **WAIT-001** `wait <box>` blocks until autostart units ready.
  - **Providers:** [all]
  - **Run:** create a box with a slow service (e.g. `sleep 5 && start`); immediately `wait <box> --timeout 30000`.
  - **Signal:** exit 0 once unit reaches `ready`; JSON output (`-j`) has `{ ready: true, timedOut: false, failed: [] }`.

- [ ] **WAIT-002** `wait --units` restricts scope.
  - **Providers:** [all]
  - **Run:** `wait <box> --units web --timeout 10000`.
  - **Signal:** returns when only `web` is ready, even if other units still starting.

- [ ] **WAIT-003** Timeout returns non-zero exit and reports failed units.
  - **Providers:** [all]
  - **Run:** create a box with a never-ready service; `wait <box> --timeout 3000`.
  - **Signal:** exit non-zero; JSON has `timedOut: true`, `failed: [...]`.

---

## 2. In-box supervisor (@agentbox/ctl)

> Tests below assume a smoke box `sv` with a writable `/workspace/agentbox.yaml`. After editing the yaml, call `agentbox-ctl reload` inside the box (or `shell` in and run it).

- [ ] **CTL-001** Valid `agentbox.yaml` accepted at create time.
  - **Run:** create a box with a simple `services: { web: { command: ['node', 'server.js'] } }`.
  - **Signal:** create succeeds; `agentbox status sv -j` lists `web`.

- [ ] **CTL-002** Invalid yaml aborts create (pre-flight ConfigError).
  - **Run:** put `tasks: { web: { command: '' } }` (empty command) in agentbox.yaml; `agentbox create -y -n bad`.
  - **Signal:** create fails before any docker work; error mentions config validation; box NOT created.
  - **Note:** Schema rejects empty command. Validate host-side before paying for docker/cloud.

- [ ] **CTL-003** DAG cycle rejected.
  - **Run:** `services: { a: { command: [...], needs: [b] }, b: { command: [...], needs: [a] } }`; create.
  - **Signal:** ConfigError mentions cycle `a → b → a`.

- [ ] **CTL-004** Unknown `needs:` reference rejected.
  - **Run:** `services: { a: { command: [...], needs: [ghost] } }`; create.
  - **Signal:** ConfigError mentions unknown unit `ghost`.

- [ ] **CTL-005** Task with `ready_when` rejected (schema mismatch).
  - **Run:** `tasks: { t: { command: [...], ready_when: { port: 3000 } } }`; create.
  - **Signal:** ConfigError mentions tasks don't support ready_when.

- [ ] **CTL-006** `ready_when: { port: 3000 }` blocks dependents.
  - **Run:** service `web` that opens port 3000 after a `sleep 5`; task `migrate` with `needs: [web]`. Watch `agentbox status sv -j` during startup.
  - **Signal:** `migrate` is `waiting` until `web` reaches `ready` (~5s in); then `migrate` transitions to `running`.

- [ ] **CTL-007** `ready_when: { http: 'http://localhost:8080/health' }` waits for 2xx.
  - **Run:** service serving 500 → 200 after delay; verify dependents wait.
  - **Signal:** `ready` only when /health returns 2xx.

- [ ] **CTL-008** `ready_when: { log_match: 'listening on' }` waits for regex.
  - **Run:** service that prints "starting…" then "listening on :3000".
  - **Signal:** `ready` after the second line.

- [ ] **CTL-009** `restart: always` respawns indefinitely.
  - **Run:** service that exits 0 after 2s; `restart: always`; watch status for 30s.
  - **Signal:** unit count of restarts ≥ 3.

- [ ] **CTL-010** `restart: on-failure` respawns only on non-zero exit.
  - **Run:** two services: one exits 0, one exits 1. Both `restart: on-failure`.
  - **Signal:** zero-exit service stays in `stopped`; failing service keeps respawning.

- [ ] **CTL-011** Exponential backoff caps at `max_ms`.
  - **Run:** failing service with `backoff: { initial_ms: 500, max_ms: 2000, factor: 2 }`; watch retries.
  - **Signal:** delays approximate 500 → 1000 → 2000 → 2000 → ... (cap holds).

- [ ] **CTL-012** `expose: { port: 3000, as: 80 }` forwards container :80.
  - **Run:** service on 3000 with `expose: { port: 3000, as: 80 }`. From host: `curl http://localhost:<docker-ephemeral>` or `curl https://<box>.localhost`.
  - **Signal:** request reaches the service on 3000; supervisor's in-process forwarder logs the proxy traffic.

- [ ] **CTL-013** Reload after editing agentbox.yaml.
  - **Run:** edit agentbox.yaml inside box to add a new service; `agentbox-ctl reload`; `agentbox status sv -j`.
  - **Signal:** new service listed; no box restart required.

- [ ] **CTL-014** `wait-ready { timeoutMs: ... }` resolves on timeout.
  - **Run:** force a never-ready service; from host `agentbox wait sv --timeout 2000 -j`.
  - **Signal:** JSON has `{ timedOut: true }`.

- [ ] **CTL-015** `run-task` reruns a completed task.
  - **Run:** task `seed` reaches `done`; from host `agentbox shell sv -- agentbox-ctl run-task seed`; check status.
  - **Signal:** task transitions `done → pending → running → done`; scheduler reran it.

- [ ] **CTL-016** Schema-drift test (CI gate).
  - **Run:** `pnpm test schema-drift`.
  - **Signal:** test passes; both the runtime parser (`packages/ctl/src/config.ts`) and the JSON schema (`packages/ctl/schema/agentbox.schema.json`) accept/reject the same fixtures.

---

## 3. Host relay (@agentbox/relay)

> Most relay behaviors are covered by RELAY-001..010 above. Additional invariants:

- [ ] **REL-EXT-001** Per-box bearer token unique and present.
  - **Run:** `cat ~/.agentbox/state.json | jq '.[] | .relayToken'`.
  - **Signal:** every BoxRecord has a unique 64-hex `relayToken`.

- [ ] **REL-EXT-002** Rehydration replays known boxes on relay restart.
  - **Run:** `relay stop && relay start`; immediately `relay status -j`.
  - **Signal:** `boxCount` matches the number of boxes in `state.json`.

- [ ] **REL-EXT-003** Ring buffer cap (1000 events) enforced.
  - **Run:** generate >1000 status events from a box; `GET /admin/events?box=<id>`.
  - **Signal:** server returns at most 1000 entries; oldest entries dropped.

- [ ] **REL-EXT-004** RPC timeout (120s for git, 600s for checkpoint) enforced.
  - **Run:** force a hung host-side git command (e.g. set remote to an unreachable host); call `git.push` from in-box.
  - **Signal:** in-box client gets a timeout error within 120s (not hang indefinitely).

- [ ] **REL-EXT-005** SSE `/admin/prompts/stream` heartbeats every 15s.
  - **Run:** `curl -sNo - http://127.0.0.1:<port>/admin/prompts/stream` and watch for 30s.
  - **Signal:** at least one `ping` event in window; reconnects when stream drops.

---

## 4. Dashboard TUI (additional)

DASH-001..012 cover the bulk. Additional checks:

- [ ] **DASH-EXT-001** Sidebar grouping by project.
  - **Run:** boxes from 2+ projects; `pnpm drive start ... dashboard`; `screen dash`.
  - **Signal:** sidebar has `── Project Name ──` headers separating groups.

- [ ] **DASH-EXT-002** Long box name truncates intelligently (keeps tail).
  - **Run:** create a box with a long name (`smoke-very-long-name-abc...`); open dashboard.
  - **Signal:** sidebar shows `…<tail>` (last hash characters visible), not `<head>…`.

- [ ] **DASH-EXT-003** Mouse click on sidebar selects.
  - **Run:** `pnpm drive` doesn't support mouse; verify manually in real terminal.
  - **Signal:** clicking another box row updates `▸` selection.

- [ ] **DASH-EXT-004** `-p` (project flag) hides boxes from other projects.
  - **Run:** in a project with boxes elsewhere: `pnpm drive start ... dashboard -p`.
  - **Signal:** only current project's boxes appear.

---

## 5. Cross-provider invariants

- [ ] **XPROV-001** Same project with boxes on multiple providers coexist.
  - **Providers:** [all]
  - **Run:** in same project: `create -y -n a` (docker), `create --provider daytona -y -n b`, `create --provider hetzner -y -n c`. `ls -j`.
  - **Signal:** all three present, each with correct `provider` field; checkpoints isolated.

- [ ] **XPROV-002** `box.defaultCheckpoint` (cross-provider) vs per-provider keys.
  - **Run:** set both `box.defaultCheckpoint=common` and `box.defaultCheckpointDocker=docker-only`; `create` (docker).
  - **Signal:** docker box boots from `docker-only` (per-provider key wins); other providers use `common`.

- [ ] **XPROV-003** Credential rotation without re-snapshot.
  - **Run:** for any provider with snapshot pinned: `agentbox claude login --force` (or analogous re-auth); `create` again.
  - **Signal:** new box has fresh credentials; no `prepare` step ran.

---

## 6. Deferred / known gaps

These appear in the test plan as **`EXPECTED-FAIL-*`** entries — they're tracked in the backlog docs and shouldn't be treated as regressions until the backlog item closes.

| ID | Description | Backlog |
| --- | --- | --- |
| EXPECTED-FAIL-DL-006 | Cloud `download.env / .config / .claude / .codex / .opencode` not routed | `daytona-backlog.md`, `hertzner_backlog.md` |
| EXPECTED-FAIL-HET-005 | `agentbox prune --provider hetzner` CLI not wired | `hertzner_backlog.md` |
| EXPECTED-FAIL-PRUNE-004 | (same as HET-005) | `hertzner_backlog.md` |
| EXPECTED-FAIL-CKPT-PAUSE | `checkpoint create --pause` flag on hetzner | `hertzner_backlog.md` |
| EXPECTED-FAIL-HET-ZEROPAUSE | True zero-cost pause on hetzner (snapshot + respawn) | `hertzner_backlog.md` |
| EXPECTED-FAIL-DAYTONA-WSCKPT | Daytona workspace-state checkpoint (`_experimental_createSnapshot` blocker) | `daytona-backlog.md` |

---

## 7. Suggested run order for an AI executor

If a Claude Code session is asked to "run the test plan for provider X":

1. **Bootstrap section (§0)** — ensure CLI builds + lints + tests green. Bail if not.
2. **Pick a clean working dir** — a fresh repo clone or a known-clean project. Note its path.
3. **For each command section in §1**, walk top-to-bottom, skipping anything not tagged for X. After each box-creating test, leave the box alive only if subsequent tests reuse it; otherwise destroy. Re-fetch state from `agentbox ls -j` rather than assuming.
4. **For §2 (supervisor)**, use the dedicated `sv` smoke box and never destroy it mid-section.
5. **For §3 (relay)**, run during/after §1 so the relay already has registered boxes.
6. **For §4 (dashboard)**, use `pnpm drive` exclusively. Tear down all `pnpm drive` sessions at end (`pnpm drive stop --all`).
7. **For §5 (cross-provider)**, only run if more than one provider was set up.
8. **Final cleanup**: `agentbox destroy -y` for every test box; `pnpm drive stop --all`; `relay restart` to confirm a clean re-rehydration.

Report results as a table of `<ID> <status: pass|fail|skipped|expected-fail> <reason if not pass>`.

---

## 8. Maintenance

When adding a new command or flag to AgentBox, add a `<CMD>-NNN` test to the relevant section above. Keep tests in the format documented in [§How to use this plan](#how-to-use-this-plan): exact run command, machine-checkable signal, one-sentence note.

When a backlog item closes, remove its `EXPECTED-FAIL-*` entry and turn it into a regular numbered test.
