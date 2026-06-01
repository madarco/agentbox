---
name: agentbox-info
description: "Spin up isolated sandboxes (\"boxes\") for coding agents, run them in parallel, queue background runs with -i, and push commits safely through the host relay. Use when the user wants to run Claude Code / Codex / OpenCode in a sandbox, start more boxes, attach to a running box, or otherwise operate the `agentbox` CLI on their laptop."
user-invocable: false
---
<!-- agentbox-managed:v1 -->

# AgentBox (host-side)

You are operating on the **user's host machine** (laptop / dev workstation), not inside a box. Use the `agentbox` CLI to provision isolated sandboxes for coding agents and to attach to them.

If you find yourself *inside* a box (`/workspace` exists and `AGENTBOX_RELAY_URL` is set in the env), this is the wrong skill — use the in-box `/agentbox-setup` skill instead.

## What AgentBox is, in one paragraph

AgentBox spins up one isolated sandbox per agent run — a local Docker container (default), a Hetzner VPS (`--provider hetzner`), a Vercel Sandbox (`--provider vercel`), or a Daytona cloud sandbox (`--provider daytona`, partial support). Each box has its own `/workspace`, but the host's `.git/` is shared, so commits made inside the box land on the host immediately. The agent inside the box has **no host credentials** — `git push`, opening URLs in the host browser, capturing checkpoints, and all other host-side operations flow through a small host process called the **relay** that runs alongside the CLI.

## The two starting commands

### `agentbox create`

Provision a box and stop. The box exists and is ready, but nothing is launched inside it.

```sh
agentbox create                       # docker, auto-named after the workspace
agentbox create -n review             # docker, friendly name
agentbox create --provider hetzner    # cloud VPS (requires `agentbox prepare --provider hetzner` once)
agentbox create --attach              # drop into a shell inside the box after create
```

Useful flags: `-n <name>` (friendly box name), `--provider docker|daytona|hetzner|vercel`, `--attach`, `-w <path>` (workspace to mount; defaults to `cwd`), `--snapshot <ref>` (start from a checkpoint).

Non-docker providers require a one-time `agentbox prepare --provider <name>` to bake the base image / snapshot.

### `agentbox claude`

Provision (same as `create`) and launch **Claude Code** inside the box, in a detachable tmux session. This is the main entry point most users want.

```sh
agentbox claude                       # docker, attaches your terminal
agentbox claude -n review             # second box, named
agentbox claude --provider hetzner    # cloud
agentbox claude -- --model sonnet     # extra args after `--` go to claude itself
```

While attached: **`Ctrl+a d`** detaches without killing claude. The box keeps running. Reattach with `agentbox claude attach <name|n>`.

Variants with the same shape for other agents: **`agentbox codex`**, **`agentbox opencode`**.

## `-i` / `--initial-prompt`: background queue

With `-i "<prompt>"`, `agentbox claude` (and `codex` / `opencode`) does **not** attach. It writes a job manifest to `~/.agentbox/queue/<id>.json` and exits immediately, printing the job id and log path. The host relay's queue loop drains these manifests respecting `queue.maxConcurrent` (global config; override per invocation with `--max-running <n>`).

Use this to fan out parallel agent runs:

```sh
agentbox claude -i "fix the failing test in src/auth and open a PR"
agentbox claude -i "draft a CHANGELOG entry from the last 20 commits"
agentbox claude -i "audit our dependencies for known CVEs"
```

Each call returns instantly. The queue drains them concurrently up to `queue.maxConcurrent`. Inspect / attach later:

```sh
agentbox dashboard                    # TUI with status + leader-key actions
agentbox claude attach <name|n>       # reattach to a specific box
```

`-i` works on every provider — pass `--provider daytona|hetzner|vercel` (or set `box.provider`) and the queued job creates a cloud box and pre-starts the seeded agent session detached, same as docker. The host must have valid agent credentials. Extra args after `--` are forwarded to the in-box agent (e.g. `agentbox claude -i "<prompt>" --provider vercel -- --permission-mode=plan`).

`-i` honors the project's `carry:` block: the carry gate runs on the host when you submit (it prompts there, since you're at the terminal), and the approved files ride the queued job and land in the box at create time. Auto-approve non-interactively with `--carry-yes` (or `AGENTBOX_CARRY_YES=1`); skip with `--carry skip` (or `AGENTBOX_CARRY=skip`).

## Forking the current session into a box

From host Claude, run the **`/agentbox`** slash command (optional arg: `docker` | `daytona` | `hetzner`) to snapshot the *current* Claude Code session into a brand-new box that resumes it. With tmux or iTerm it opens in a new terminal tab; otherwise it starts in the background. The host session is unaffected — you get two parallel timelines. The underlying CLI is `agentbox fork` (`agentbox fork --help`); `/agentbox` requires `agentbox install` to have been run once. This is distinct from `-i`, which seeds a *new* prompt rather than resuming the live conversation. Fork **sends** the project's `carry:` block by default (the host is trusted; the box is the untrusted side, so host→box copy is safe) — opt out with `agentbox fork --carry skip`.

## Driving one agent from another (`drive`, `agent`, `queue wait-for`)

When *you* are the host-side agent and want to orchestrate other agents running inside boxes — read what they're doing, send them a prompt, wait until they're done or need input — use these three command families. Everything is stateless / one-shot, and the human-text default switches to machine-friendly JSON with `--json`.

### `agentbox drive <box>` — terminal driving

Targets the running tmux session inside a box (auto-picks the agent session: `claude` → `codex` → `opencode` → the only running session; override with `--session <name>`). Provider-uniform — works the same on docker / daytona / hetzner / vercel.

```sh
agentbox drive snapshot 1                          # print rendered TUI as plain text
agentbox drive snapshot 1 --with-cursor            # JSON envelope: { session, cols, rows, cursor, screen }
agentbox drive snapshot 1 --ansi --rows -200:-1    # include color, walk into scrollback
agentbox drive keypress 1 "<C-c>"                  # DSL: <Enter>, <C-x>, <Tab>, <F5>, <Up>, etc.
agentbox drive send-text 1 "hello"                 # literal text, no DSL parsing, no trailing Enter
agentbox drive prompt 1 "summarize /workspace/README" # type + Enter (the convenience action)
agentbox drive wait 1 --text "✓" --timeout 60000   # block until <text> appears on screen
agentbox drive resize 1 200 60
```

`keypress` uses a small DSL: `<Enter>`, `<Tab>`, `<Esc>`, `<Space>`, `<BS>`, `<Del>`, `<Up>/<Down>/<Left>/<Right>`, `<Home>/<End>/<PageUp>/<PageDown>`, `<F1>`–`<F12>`, `<C-a>`..`<C-z>`. Use `<<` for a literal `<`. Multiple args concatenate with no spaces (`"ls" "<Enter>"` → `ls\r`).

### `agentbox agent <box>` — agent state introspection (Claude / Codex / OpenCode)

Sub-second latency. State source by agent:

- **Claude Code**: lifecycle hooks (`UserPromptSubmit`, `PreToolUse`, `Stop`, `Notification`, `ExitPlanMode`, `AskUserQuestion`, `PreCompact`/`PostCompact`, `StopFailure`, `SubagentStart`/`SubagentStop`).
- **Codex**: tmux-pane scraper inside the box (codex 0.134.0's own hook firing is unreliable; staged hooks remain for the day that's fixed upstream).
- **OpenCode**: a plugin (`agentbox-state.js`) seeded into the OpenCode config volume, subscribing to OpenCode's event bus.

All three feed the same status pipeline; `agent state` / `agent wait-for` work the same regardless of which agent runs inside the box. Reports come from `~/.agentbox/boxes/<id>/status.json` and the relay event stream.

```sh
agentbox agent state 1                # → working | idle | waiting | end-plan | question | prompt | compacting | error
agentbox agent state 1 --json         # full BoxStatusClaude (state, updatedAt, sessionTitle, plan?, question?)

agentbox agent wait-for prompt 1 --timeout 600000      # block until Claude is at the input box, no pending plan/question
agentbox agent wait-for end-plan 1                     # Claude just called ExitPlanMode; user has to approve
agentbox agent wait-for question 1                     # AskUserQuestion picker is up
agentbox agent wait-for idle 1                         # Stop hook fired (turn complete)
agentbox agent wait-for compacting 1                   # Claude is summarizing context (PreCompact fired)
agentbox agent wait-for error 1                        # Claude's turn ended with a failure (StopFailure)

agentbox agent get-plan-question 1            # print the plan body OR question + options (human)
agentbox agent get-plan-question 1 --json     # structured payload
```

The `prompt` state is derived: `idle` AND tmux session alive AND no pending plan/question — i.e. "ready for the next user message". Use it as the natural sync point after sending a new prompt.

The `end-plan` and `question` matchers tolerate the race where Claude's `Notification:permission_prompt` hook flips the raw state to `waiting` immediately after the matcher hook fires — both states still match while the plan/question payload is pending, and only the matching `PostToolUse` (handled internally with `--clear-pending`) resets them.

### `agentbox queue wait-for <event>` — queue + box lifecycle

```sh
agentbox queue wait-for new-box                          # any new box gets registered
agentbox queue wait-for empty-queue --timeout 1800000    # all queued/running jobs settled
agentbox queue wait-for box-running --box review
agentbox queue wait-for box-paused  --box 2
agentbox queue wait-for box-stopped --box 2
agentbox queue wait-for job-done --job b45f1603841bd2b5  # terminal status (done/failed/cancelled)
```

All wait-for commands exit 0 on match, exit 1 on timeout, and accept `--json` for parseable output.

### Recipe: queue a plan, then act per turn

This is the canonical "drive a Claude Code from another Claude Code" loop. You queue an initial planning prompt, wait for the plan to land, capture it, decide, send the next message, repeat.

```sh
# 1. Kick off a box with a planning prompt.
agentbox claude -n design -i "Plan how to add an OAuth login flow to apps/web, then enter plan mode. Don't start coding."

# 2. Wait until Claude is at the ExitPlanMode approval prompt.
agentbox agent wait-for end-plan design --timeout 600000

# 3. Read the plan back as text (or JSON) and decide.
PLAN=$(agentbox agent get-plan-question design)
echo "$PLAN"

# 4. Approve via tmux — option 1 ("Yes, and use auto mode") is already highlighted.
agentbox drive keypress design "<Enter>"

# 5. Wait for the turn to finish.
agentbox agent wait-for prompt design --timeout 1200000

# 6. Fan out follow-up work to a fresh box, in background, while reviewing this one.
agentbox claude -i "Write the OAuth provider unit tests in apps/web/test/auth/"

# 7. Block until everything settles before reporting back.
agentbox queue wait-for empty-queue --timeout 3600000
```

The same shape covers `agent wait-for question` + `agent get-plan-question` (read the choices, send the answer index via `drive keypress 1 "<Down><Enter>"`, then `wait-for prompt`).

### Quick mental model

- `drive` = "send keystrokes / read screen" — provider-uniform tmux capture-pane / send-keys.
- `agent` = "what is the Claude TUI currently doing" — hook-driven, race-free, machine-readable.
- `queue wait-for` = "block on queue or box lifecycle transitions" — poll-based, no new endpoint.
- All three commands are **stateless** — safe to invoke from any script, any agent, in parallel.
- `--json` everywhere. Default human text is for the operator; an agent should pass `--json`.

## Git through the host relay

**The box has no SSH keys, GPG keys, or git remote credentials.** Don't ask the user to add any. When an in-box agent (or a script you run inside the box) does `git push` or `git pull`, the AgentBox-provided `agentbox-ctl git` wrapper POSTs a JSON-RPC call to the host relay (`POST /rpc`, bearer-auth, loopback-only). The relay runs the **real** `git push origin …` on the host, using the user's `SSH_AUTH_SOCK`, `~/.gitconfig`, and identity — and streams stdout/stderr back into the box's terminal. The box's exit code matches the host's.

Implications for you, the host-side agent:

- Inside the box you can `git commit … && git push` exactly as normal. No setup needed.
- Pushes are gated host-side: the relay can require a confirm prompt for destructive operations (the user sees it in the dashboard footer, ~25 s TTL). If a push appears to hang, tell the user to check the dashboard.
- The relay process is started lazily by the first `agentbox create` / `agentbox claude` and persists across runs (PID at `~/.agentbox/relay.pid`, log at `~/.agentbox/relay.log`). You normally don't need to manage it.
- For HTTPS origins (`https://github.com/...`), pushing usually needs a credential — recommend the user run `gh auth login` and `gh auth setup-git` once on the host. After that, host `git push` uses gh's OAuth token automatically. SSH origins (`git@github.com:...`) keep using the host's SSH agent as before.

## PRs through the host relay (`agentbox-ctl git pr …`)

In-box agents can drive GitHub PRs from inside a box via the host's `gh` CLI. Same model as `git push`: the box has no GitHub token; the relay shells out to `gh` on the host with the user's authenticated gh identity. Requires `gh` installed on the host and `gh auth login` run once.

The wrapper is `agentbox-ctl git pr <op> [args...]`. Available ops:

| Op | Prompt? | Notes |
| --- | --- | --- |
| `view <num>` | no | Read-only. |
| `list` | no | Read-only. |
| `create` | yes | Pass-through args (e.g. `--title T --body B --draft`). |
| `comment <num>` | yes | Visible to others. |
| `review <num>` | yes | Visible to others. |
| `close <num>`, `reopen <num>` | yes | |
| `merge <num>` | yes (+ bypass guard) | `AGENTBOX_PROMPT=off` auto-`y` is refused here unless `AGENTBOX_GH_FORCE=1` is also set. |
| `checkout <num>` | yes (+ opt-in) | Off by default — switches the host main repo's branch (visible to the box). Enable with `AGENTBOX_GH_PR_CHECKOUT=allow`; a dirty host tree is refused, and a host HEAD on a registered box branch is refused. |

If a PR op appears to hang, tell the user to check the dashboard footer for the host confirmation prompt. If `gh` is missing or unauthenticated, the in-box command exits 127 / 4 with a clear stderr.

## Other commands worth knowing

| Command | What it does |
| --- | --- |
| `agentbox dashboard` | TUI status + switcher across all boxes. The leader is **`Ctrl+a`** (e.g. `Ctrl+a u` opens the box's web URL; `Ctrl+a s` opens the in-box browser; `Ctrl+a q` quits). |
| `agentbox shell [n\|name]` | Interactive `bash -l` inside the box (also wrapped in tmux by default — detach with `Ctrl+a d`). |
| `agentbox url [n\|name]` | Open the box's web app URL (`<box-name>.localhost` via Portless) in the host browser. |
| `agentbox screen [n\|name]` | Open the box's **own** Chromium via VNC — useful for OAuth flows the agent inside the box initiates. |
| `agentbox code [n\|name]` | Open VS Code / Cursor pointed at the box. |
| `agentbox prepare --provider <name>` | One-time base image / snapshot build for `daytona` or `hetzner` or `vercel`. With no `--provider`, prints status across all providers. |
| `agentbox prune --provider <name>` | Clean up orphan boxes / images / snapshots for a provider (docker + daytona supported; hetzner pending). |

Per-project numeric index (`1`, `2`, …) and friendly name (`review`, `smoke`) both work wherever `<box>` is accepted. Index `1` is the first box created in the current workspace.

## Operating principles

1. **Never assume the host needs SSH keys forwarded into a box** — git is handled by the relay, by design.
2. **Use `-i` whenever the user asks for parallel agent work** rather than spawning multiple foreground sessions. Then point them at `agentbox dashboard` to watch progress.
3. **Pick the provider deliberately.** `docker` is the fast default. `--provider hetzner` gives a real VPS (heavier, isolated, requires `agentbox prepare --provider hetzner` once). `--provider vercel` is the managed cloud option.
4. **Cross-check before recommending a command.** If a flag isn't listed here, run `agentbox <command> --help` (it's safe and read-only) before suggesting it to the user.
5. **`/agentbox-setup` is a different skill.** It runs *inside* a box to generate `/workspace/agentbox.yaml`. Don't conflate it with `/agentbox` (host-side fork) or this reference skill.

## Reference

- Full docs live in the repo at `docs/` — start with `docs/architecture.md` and `docs/create-and-checkpoints.md` for the model, `docs/host-relay.md` for the relay, `docs/cloud-providers.md` for the cloud paths.
- npm package: `@madarco/agentbox` — `npm -g install @madarco/agentbox` (or `npx @madarco/agentbox <command>`).
