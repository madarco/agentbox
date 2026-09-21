# Release E2E plan

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). Replaces the per-command checklist in [`test-plan.md`](./test-plan.md) once Phase 7 lands.

Before every release we run a small number of **real-life scenarios** against the **installed CLI**, on every provider and on a Linux host. Each scenario is a flow a user actually goes through: a fresh install, then an agent turn that ends in a merged PR. One scenario asserts many things. A human can read the report and say "yes, that's what a user sees".

Nothing here runs in GitHub CI. It runs locally, with real bakes, real boxes, real `gh` PRs and merges, and real cloud spend.

## Principles

- **About 8 scenarios, not 300 checks.** A scenario is an ordered list of named steps. Each step asserts ground truth: a provider SDK call, `gh api`, the hub `/api/v1` payload, a file inside the box. Exit codes don't count.
- **Edge cases come after the flow.** Each scenario ends with a few short, independent checks that reuse the box the flow left behind (for example "carry on a non-TTY without opt-in fails loud"). They are cheap because the expensive setup is already done.
- **Test what ships.** `npm pack` the CLI, install it into an e2e prefix, and run it from there. Packaging bugs never repro from the dev symlink.
- **Same machine, separate `HOME`.** See [Isolation](#isolation). No docker-in-docker, no VM for the Mac run.
- **Parallel by target.** Every target (provider × host) is its own worker. Scenarios within a target run in parallel where they don't share a box.
- **Scripted first, AI for judgement.** Steps are deterministic code. Where an assertion is fuzzy (does the tray menu look right? did the TUI render the session?), the step captures a screenshot or screen dump and asks a headless Claude judge a yes/no question with a stated expectation. The judge's verdict and the evidence go in the report.

## Targets

| Target | Host | Notes |
|---|---|---|
| `docker@mac` | this Mac, e2e `HOME` | Cap at 2 concurrent boxes (the Docker VM OOMs at about 3 build-heavy boxes). |
| `docker@linux` | the Hetzner test VM ([`scripts/hub-test-vm.sh`](../scripts/hub-test-vm.sh)) | The same runner, shipped with `hub-test-vm.sh deploy`. Results are copied back. |
| `remote-docker` | Mac → the Linux test VM over SSH | Exercises the sync path against a docker engine the user owns. |
| `daytona` | this Mac | 10 GB/sandbox cap: keep the test repo small. |
| `hetzner` | this Mac | Mind the account's server quota. |
| `vercel` | this Mac | Max 4 exposed ports, `iad1` only. |
| `e2b` | this Mac | Hobby tier: 1 h session cap and a concurrency limit. |

The tray only runs on `*@mac` targets, since it is a macOS app. It follows the e2e hub, whichever provider the boxes are on.

## Scenarios

Each row lists the steps of the flow, then the edge cases run after it. The `covers` column maps back to the IDs in [`test-plan.md`](./test-plan.md), so no coverage is silently dropped.

### S1. Fresh install and first bake

A new user installs AgentBox and gets to a baked, healthy setup.

- Install the packed tarball into the e2e prefix. `agentbox --version` matches the tarball, and `agentbox` with no args prints help.
- `agentbox install` non-interactively (the wizard path the website tells users to run).
- `agentbox hub start`: `/healthz` returns 200 unauthenticated. `/api/v1/boxes` without the token returns 401, and with it returns 200.
- `agentbox <provider> login --status` reports the seeded credential.
- `agentbox prepare --provider <p>` does a real bake through the hub queue. The prepared-state file or image exists, and `prepare --status` reports it.
- The tray (Mac only) launches against the e2e hub and shows it as connected.

Edge cases: `prepare` again is a fast skip; relay admin endpoints reject non-loopback callers; `/rpc` without a bearer is refused.

Covers: BOOT-001/002, PREP-001..006, RELAY-001/004..006.

### S2. Agent round trip to a merged PR

The core flow. Run once per agent: `claude` on every target, `codex` and `opencode` on docker targets plus one cloud per release, rotating.

- Start from a test repo with a dirty tree: a staged change, an untracked file, a `carry:` entry.
- `agentbox <provider> <agent> -i "<prompt>"` creates the box. The box is `ready`, the staged and untracked files are in `/workspace`, and the carried file is at its destination, owned by the box user.
- The agent does a real logged-in turn: it creates a file and commits it on the box branch. "Ready" is not "usable", so this step is required.
- Push through the host relay. The branch exists on GitHub (`gh api`).
- `gh pr create`, then `gh pr merge --squash`. The PR is `merged` on GitHub, and the hub workspace timeline reports `Box.pr.state == merged` with the right `branchUrl`.
- `agentbox ls -j` and `GET /api/v1/boxes` agree on the box's state and branch.
- Tray (Mac): the box row appears under its project with the PR label.

Edge cases: carry on a non-TTY without opt-in fails loud; `AGENTBOX_CARRY=skip` copies nothing; an invalid `agentbox.yaml` aborts create before any spend; `attach` finds the live session and doesn't start a new one.

Covers: CLAUDE-001..004, CODEX-*, OPENCODE-*, CREATE-001..003, CREATE-010, CREATE-013..015, ATTACH-001, RELAY-008/009, LS-001..003, CTL-002.

### S3. Lifecycle and checkpoints

The box from S2 survives everything a user does to it over a week.

- Pause and resume, then stop and start. A marker file in `/workspace` survives each step, and the agent session comes back on `claude start`.
- `checkpoint create`, then `create --snapshot <it>` makes a second box that has the marker.
- `checkpoint set-default`, then a plain create uses it; `set-default --clear`, then `checkpoint rm`.
- `destroy -y` on both boxes. The provider SDK lists no sandbox, server, snapshot or volume carrying the run id.

Edge cases: `start` on a running box is a no-op; `destroy --keep-snapshot` keeps the checkpoint; on docker, `checkpoint create --merged` flattens.

Covers: PAUSE-*, START-*, CKPT-*, DESTROY-*, CREATE-004.

### S4. A project with services

A real app runs in the box and the user reaches it from the host.

- Use `examples/express-ready`, whose `agentbox.yaml` has a DAG with `ready_when` port, http and log checks, plus a restart policy.
- `agentbox wait` returns when the units are ready. `status` shows them running, and `logs <svc>` has the expected line.
- `agentbox url --print` returns 200 from the host. On cloud targets this is the preview URL, and on docker it is the Portless or loopback URL.
- `screen --print` returns a VNC URL that answers.
- `cp` a file in and out; `download` pulls `/workspace` back.
- Kill the service process: `restart: always` brings it back.

Edge cases: `wait --units` with a unit that never becomes ready times out non-zero and names it; editing `agentbox.yaml` and reloading applies the change.

Covers: WAIT-*, STATUS-*, LOGS-*, URL-*, SCREEN-*, CP-*, DL-001..005, CTL-006..015, TOP-*.

### S5. Host tools, approvals and secrets

What the box is allowed to reach on the host, and how the user approves it.

- From inside the box, call an ungranted host tool. It is refused, and the message names both remedies.
- Request it. The approval appears in `GET /api/v1/approvals`. Answer it through `/api/v1/approvals/{id}/answer`, and the tool works at once without a restart.
- A credential-deny rule blocks the known credential argv; `strict` mode prompts every call; revoking removes the command.
- No host credential reaches the box: grep the box's env and filesystem for the seeded token values.

Covers: TOOLS-001..009, RELAY-010.

### S6. Service agent (openclaw)

A bot a user runs rather than attaches to.

- `agentbox openclaw` reaches `ready`, and the URL answers with the box's real gateway token.
- The `openclaw:` overlay reaches the config, and an in-box hand edit survives a restart.
- Backup, restore into a new box, and clone, all through `/api/v1`.

Edge cases: a bad overlay writes nothing; the gateway identity never leaves its box.

Covers: CLAW-001..006.

### S7. Workspace, tasks and manager

The multi-box flow a user drives from the manager.

- Create a workspace over two test repos and add tasks to it.
- The hub starts the manager in its tmux session (under the e2e `TMUX_TMPDIR`), and the manager starts a box for a task.
- The workspace timeline shows the box, its branch lane and its PR. `POST /api/v1/managers/{id}/message` reaches the manager.
- Tray (Mac): the Manager window opens on the workspace and its Timeline shows the same rows.

### S8. Interactive surfaces

What the user sees on screen. Evidence goes into the report as screen dumps and screenshots, checked by the AI judge.

- `agentbox dashboard` through `pnpm drive`: the sidebar lists the boxes, `Ctrl-a` opens the leader menu, switching boxes works, `Ctrl-a q` quits cleanly.
- `agentbox shell <box>`, a one-shot `shell -- <cmd>`, then `shell ls` and `shell kill`.
- Tray (Mac): open the menu; the New Box panel picks the right project and provider; start, stop and push a box from the menu, and check the effect through `/api/v1`.
- Hub web UI (Playwright): the boxes page lists the same boxes, and the approval from S5 can be answered there.

Covers: DASH-*, SHELL-*, the tray and web UI (no IDs today).

### Dropped from the release run

- **Config plumbing (`CFG-*`) and schema checks (`CTL-003..005`, `CTL-016`)** are pure logic. They move to vitest unit tests, if they aren't already there.
- **`code` / VS Code (`CODE-*`)** needs a GUI editor. Leave it manual.
- **Remote hub / control box** stays in [`hub-testing.md`](./hub-testing.md). It may become S9 on the Linux target later.

## Isolation

The whole run lives in an e2e `HOME` (`~/.agentbox-e2e/home`) on the same machine. A separate `HOME` isolates the registry, secrets, logs, hub token and relay state, but several things are shared regardless. The harness handles each one:

| Shared | Risk | Handling |
|---|---|---|
| `prune` | `prune --provider X` deletes cloud sandboxes "not in this fleet's state". From the e2e `HOME`, **your real boxes look like orphans and get deleted**, and your own prune kills e2e boxes. `prune --all` does the same for docker. | The harness never calls `prune`. Cleanup is `destroy` plus an SDK sweep by the `e2e-<runid>-` prefix. Don't prune by hand during a run. |
| Hub/relay port 8787 | Collides with your hub | `relay.port: 8797` in the e2e `HOME`. |
| tmux default socket (`/tmp/tmux-<uid>/`) | Manager sessions land in your tmux server | `TMUX_TMPDIR=$E2E_HOME/tmux`. |
| Docker daemon, images, `agentbox-claude-config` / `agentbox-codex-config` volumes | Name clashes; e2e boxes write your agent config volumes | Run-id box names. The config volumes are shared on purpose: it's your own login. |
| Portless (80/443, `~/.portless`) | Shared proxy | Portless stays on (S4 checks it). Routes carry the run-id box names. |
| Keychain (Claude OAuth, `gh`) | `gh` would act as you | `GH_TOKEN` set to the test account's token. Reading your Claude login is fine. |
| Cloud accounts | Shared quotas | Only matters near the limits. |

The e2e `HOME` holds a symlinked `~/.claude` and `~/.claude.json`, a seeded `~/.agentbox/secrets.env` and the agent-login backups (the same vault shape as `hub-test-vm.sh creds`). A guard refuses to start if `$HOME` resolves to your real home.

**Tray under test:**
- Run the unbundled `.build/release/AgentBox` with `HOME=$E2E_HOME`, not `open AgentBox.app`: `open` goes through launchd and drops `HOME`, and the bundle's Get started registers a login item.
- The tray shells `zsh -lc 'agentbox …'`, so the e2e `HOME` gets a `.zprofile` putting the e2e prefix's `bin` first on `PATH`.
- It follows the e2e hub through a remote `HubTarget` (`http://127.0.0.1:8797` plus the e2e token), forced by a launch argument so it never reads your real UserDefaults.
- Two status items are in the menu bar. The driver finds the test one by PID.
- UI driving sends keystrokes to the frontmost app, and a locked screen ends AX. The tray steps run only when the Mac is free (overnight or on request); everything else runs while you work.

## Parallelism

1. **Bake phase.** S1 runs on every target at once. The slowest bake sets the wall-clock time.
2. **Flow phase.** S2–S8 run per target, in parallel where they don't share a box: S2 → S3 chain on one box, S4, S5 and S6 each get their own box, S7 needs its two repos, S8 reads the boxes the others left. Docker on the Mac is capped at 2 concurrent boxes.
3. **Sweep.** Destroy by prefix, verify with each provider's SDK, delete the `e2e/<runid>/*` branches on GitHub.

Everything is named `e2e-<runid>-<target>-<scenario>`: boxes, branches, PRs, workspaces. That keeps parallel runs from colliding and makes the sweep a prefix match.

Expected wall-clock time: about 20–30 minutes for the full matrix. `--reuse-bake` skips S1's bake for re-runs after a fix.

## Report

Each run writes `e2e/runs/<sha>-<runid>/`:

- `summary.json`: target × scenario × step → `pass | fail | skip | expected-fail`, with durations and the covered test-plan IDs.
- `report.html`: a target × scenario grid. Each cell expands to its steps, each failing step to its log excerpt, and each judged step to its evidence (screenshot or screen dump) and the judge's reason.
- Per-target logs: the CLI's `~/.agentbox/logs`, the hub log, and the `pnpm drive` transcripts.
- API snapshots: `GET /api/v1/boxes`, the timeline and `managers`, saved as fixtures for the tray's `HubPayloadTests`.

## Layout

- `e2e/` is a new workspace package (add `'e2e'` to `pnpm-workspace.yaml`), kept out of `pnpm test`.
- `e2e/scenarios/s1-install.ts` … `s8-surfaces.ts`: a scenario is an ordered list of `step(name, fn)` plus `edge(name, fn)` entries. A failed step skips the rest of the flow, but the edge cases that don't depend on it still run and the teardown always runs.
- `e2e/lib/`: the e2e `HOME` bootstrap and guard, the tarball install, an `/api/v1` client, `gh` helpers, provider-SDK sweep and leak checks, the tray AX driver, the Playwright helpers, the judge.
- `pnpm e2e --targets docker@mac,e2b --scenarios s2,s3 [--reuse-bake] [--keep] [--no-tray]`.

## Phases

1. **Harness.** The e2e `HOME` bootstrap, the real-`HOME` guard, the tarball install, the runner (`step`/`edge`/teardown), prefix cleanup and the `summary.json` report. Done when an empty scenario runs, reports and cleans up on `docker@mac`.
2. **S2 on docker@mac.** The walking skeleton: dirty repo → claude turn → push → PR → merge → timeline. Done when a green run leaves a merged PR and nothing else behind.
3. **S1 and S3, plus the cloud targets.** Real bakes in parallel, the lifecycle scenario, per-provider leak checks. Fold in `scripts/vercel-live-e2e.sh`.
4. **S4, S5, S6.**
5. **Tray.** Accessibility identifiers in the tray, the launch argument that forces the hub target, a Swift AX + CGEvent driver, the payload fixtures in `HubPayloadTests`, then the tray steps of S1, S2, S7 and S8.
6. **Linux and remote-docker.** Run the runner on the Hetzner test VM as `docker@linux`, and point `remote-docker` at it from the Mac.
7. **Judge and gate.** The AI judge for S8 and the tray steps, `report.html`, and the `/release-notes` gate: no tag unless a green `summary.json` exists for `HEAD`. Then retire `test-plan.md`, keeping only the coverage map.

## Open questions

- **Clean-Mac install test.** A macOS VM (Tart locally, or Daytona's use.computer Macs) would test the tray's first-run wizard and login item on a machine that has never seen AgentBox. Needs a one-hour PoC of each before choosing; not needed for Phases 1–7.
- **Agent rotation.** Running codex and opencode on every cloud every release roughly triples S2's spend. The plan rotates them; revisit if a regression slips through.
