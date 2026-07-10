# Guided agent login — plan + findings

## Why

`agentbox <agent> login` (claude, codex, opencode) hands the user's terminal **directly to the
agent's own in-container TUI**: each is a `spawnSync('docker', ['run','-it',…], { stdio: 'inherit' })`
(`packages/sandbox-docker/src/sync/agents/{claude,codex,opencode}.ts`). The TUI then negotiates
raw-mode and enhanced-keyboard sequences with whatever emulator it finds, and AgentBox controls
none of it.

A user on **kitty** reported `agentbox claude login` becoming unusable: once the browser opened,
the "Paste code here" prompt stopped accepting input. `--headless` + `--code` worked, but it isn't
the default. Terminals speaking the kitty keyboard protocol / CSI-u are the trigger (same family as
the `Ctrl+V` CSI-u problem in `dashboard`).

A terminal allowlist ("use headless unless iTerm/tmux") is the wrong axis — it hardcodes today's
known-good set and breaks on the next emulator.

**Fix:** never give the container's TUI the user's terminal. Drive the login container under
**node-pty**, keep its raw stream in the command log, and conduct the interaction from the host with
our own clack prompts. `apps/cli/src/lib/claude-login-run.ts` (`runClaudeLogin`) already does this
for claude's `--headless` worker and the hub create-job worker. Generalize it, make it the **default**
in a TTY (`guided`), and keep `--interactive` as the explicit escape hatch back to the passthrough
(also the automatic fallback when the optional node-pty prebuild is absent).

## Login modes

| mode | when | behavior |
| --- | --- | --- |
| `code` | `--code <CODE>` | deliver a code to a pending headless session (claude only) |
| `headless` | `--headless`, or no TTY | print the auth URL + `AGENTBOX_LOGIN_URL=` marker, finish with `--code` (claude only) |
| `guided` | **default in a TTY** | drive the container under node-pty; prompt on the host with clack |
| `interactive` | `--interactive`, or no node-pty prebuild | legacy passthrough (`stdio: 'inherit'`) |

---

## Phase 0 findings (captured 2026-07-10, box image binaries: codex 0.144.1, opencode 1.17.18)

Captured by driving each binary under node-pty (`cap.cjs`) with throwaway `CODEX_HOME` /
`XDG_DATA_HOME`, then stripping CSI/OSC escapes.

### codex — `codex login --device-auth` → `browser-only`, no keystroke

```
Welcome to Codex [v0.144.1]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   YQ16-PPHIE

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
```

Then it polls until the browser completes; nothing is ever typed. So codex is `input: 'browser-only'` —
extract **both** the URL (`https://auth.openai.com/codex/device`) and the one-time code
(`^[A-Z0-9]{4}-[A-Z0-9]{4,6}$` on its own line), print them from the host, and wait for exit.

Because nothing must be typed, guided codex also works with **no TTY**.

Also on the surface (not used): `--with-api-key` / `--with-access-token` read from **stdin** — a
clean non-interactive path if we ever want one.

### opencode — `opencode auth login` → an arbitrary per-provider prompt *tree*

`-p/--provider <id>` and `-m/--method <label>` both exist and skip the corresponding select. The
prompts are **clack** (rendered in-container).

Bare — a searchable provider select:

```
┌  Add credential
│
◆  Select provider
│  Search: _
│  ● OpenCode Zen (recommended)
│  ○ OpenAI
│  ○ GitHub Copilot
│  ○ Google
│  ○ Anthropic
│  ○ OpenRouter
│  ○ Vercel AI Gateway
│  ...
```

`-p anthropic` — a single text prompt:

```
┌  Add credential
│
◆  Enter your API key
│  _
```

`-p opencode` — a note + the same single text prompt:

```
┌  Add credential
│
●  Create an api key at https://opencode.ai/auth
│
◆  Enter your API key
│  _
```

`-p github-copilot` — **a nested select**, not a single prompt:

```
┌  Add credential
│
◆  Select GitHub deployment type
│  ● GitHub.com (Public)
│  ○ GitHub Enterprise
```

**Consequence for the design:** opencode's flow is provider-shaped and open-ended (plugins can add
providers and prompts), so it cannot be fully guided without reimplementing opencode's provider
registry. Guided opencode therefore covers the **two prompt shapes we can recognize** — "Enter your
API key" (host clack `password`) and a printed OAuth URL — and **falls back to the passthrough**,
with an explanatory message, on any other prompt (e.g. github-copilot's deployment-type select).

Provider ids are enumerable in-container: `opencode models` prints `provider/model` lines, so the
unique prefixes are valid `-p` values (`opencode`, `openai`, `github-copilot`, `google`,
`anthropic`, …). `opencode auth login -p nosuchprovider` fails fast with
`Error: Unknown provider "nosuchprovider"`.

### claude — `claude auth login` → `paste-code` (unchanged)

Already handled by `runClaudeLogin`: prints an OAuth URL on `claude.com/cai/oauth/…` (or
`claude.ai` / `console.anthropic.com`), then reads a pasted code. `extractOAuthUrl` covers it.

---

## Phases — all shipped

- **Phase 0** — empirical capture (above).
- **Phase 1** — the pty core, generalized:
  - `apps/cli/src/lib/agent-login-specs.ts` — pure per-agent prompt detectors (`AgentLoginSpec`,
    `LoginNeed`). `extractOAuthUrl` moved here; `claude-login-session.ts` re-exports it.
  - `apps/cli/src/lib/agent-login-run.ts` — `runAgentLogin`, the pty loop.
  - `apps/cli/src/lib/agent-login-bindings.ts` — per-agent docker argv + `verify`/`finalize`.
  - `apps/cli/src/lib/claude-login-run.ts` — now a thin wrapper, so `_claude-login-worker.ts` and
    `_run-queued-job.ts` are untouched.
- **Phase 2** — guided mode for claude: `selectLoginMode` gained `guided`;
  `apps/cli/src/lib/guided-login.ts` runs the host-side clack prompts; `--interactive` flag; a
  `signInToClaude` seam shared with the first-run offers (`maybeRunClaudeLogin`,
  `maybeRunCloudClaudeLogin`).
- **Phase 3** — guided mode for codex (`browser-only`). Guided only for `--device-auth`; other
  methods (`--api-key`, `--with-access-token`) never print a URL, so they go straight to the
  passthrough rather than waiting out the 60s URL timeout. `codex login` no longer requires a TTY.
- **Phase 4** — guided mode for opencode, bounded as above. The provider id is asked for on the
  host and passed as `--provider`, which skips opencode's own picker; an unrecognized prompt falls
  back to the passthrough, and an unknown provider id is reported (not retried).
- **Phase 5** — tests (`apps/cli/test/agent-login-specs.test.ts` fed the real transcripts above,
  plus the widened `selectLoginMode` matrix) and docs (`apps/web/content/docs/cli.mdx`,
  `run-an-agent.mdx`).

### Verified live (2026-07-10)

Driven through the PTY harness against the **real** agent binaries, with only the docker layer
replaced by an argv shim:

- **claude** — our clack "Paste the code from the browser" prompt renders on the host; a submitted
  code is written back into the pty; a rejected code surfaces `the code was not accepted — paste a
  fresh one` and re-prompts. No Claude TUI frames on screen; the raw stream lands in
  `~/.agentbox/logs/claude-login.log`.
- **codex** — the device URL and one-time code print from the host, then a "waiting for you to
  approve in the browser" spinner. No keystroke required.
- **opencode** — `-p anthropic` reaches our masked "Enter your API key" prompt; `-p github-copilot`
  is detected as unsupported (`it asks to Select GitHub deployment type`) and falls back;
  `-p nope` reports `unknown provider "nope"`.

## Non-goals

- No host-side browser auto-open. The login container runs with `DISPLAY=` blanked precisely to
  force the terminal paste-code flow, and focus-stealing is half the reported complaint.
- No terminal allowlist. `detectHostTerminal` is used only for a fallback warning, never to pick a mode.
- No `--headless`/`--code` for codex or opencode.
