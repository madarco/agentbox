# Agent live status: title, working-on line and tokens per box

**Status:** Phases 0-3 done; Phase 4 done for the hub web, the CLI and the public docs (the tray is tracked separately). Open items: [`agent-live-status-backlog.md`](./agent-live-status-backlog.md).

Every box should tell the hub, the web UI and the tray four things about the agent in it:

1. its **status** (working, waiting, idle, error);
2. the **title** of the session the user is in now, which must follow `/new`, `/resume` and a rename;
3. a short **working-on line** ("bash: npm test", "Review server.js for bugs");
4. the **tokens** the current session has used.

Status and a session title already reach the hub (`Box.agentStatus[agent].{state, sessionTitle}`),
the tray reads both, and ctl re-sends them every 15s. But the title comes from the tmux pane title,
which is wrong or stale for most agents, the working-on line does not exist, tokens only reach
`/api/v1/usage` and never the box, and the PoC found a status bug in every agent.

**Not a goal: real-time.** A value that is 15-60s old is fine. The design must add no traffic of
its own: nothing here may push to the relay or the hub per tool call or per token update.

## Design

Two halves, split by where each fact can be seen:

- **In the box: status and the current session id.** Only the box sees these: the hooks and plugins
  fire there, and only the box knows which session is on screen. They ride the existing status
  snapshot (`StatusReporter` -> relay `box-status` -> `status.json`), which already debounces to
  300ms and re-sends every 15s.
- **In the hub: title, working-on line and tokens.** These are all in the agent's transcript, and
  the history pipeline ([`agent-history-plan.md`](./agent-history-plan.md)) already ships every
  agent's transcripts to the hub and parses them with each agent's own module. The hub joins the
  box's current session id (from the status snapshot) to that session's parsed rows and derives
  the three values.

Why not extract everything in ctl, as each PoC recipe sketched:

- ctl is baked into the box image, so every parsing tweak for a new agent version would need a
  re-bake on every provider. The agent modules the hub loads change with a CLI update.
- The parsing already exists hub-side for history; a second copy at the edge would drift from it.
- Shipping is already batched (the docker host watcher every 60s, the ctl shipper every 30s), so
  the hub-side values cost no new traffic. A ctl extractor would need its own debounce and its own
  payload on every snapshot.

The price is lag: a title or working-on line is up to one ship interval plus a parse old. That is
inside the "not real-time" budget.

### Debounce rules

- **Status:** unchanged. A hook or plugin calls `agentbox-ctl agent-state`; ctl pushes on a change
  (300ms debounce) and re-sends every 15s.
- **Session id:** carried in the same snapshot. A change of session is a status change, so it
  pushes at once; it fires at most once per `/new`.
- **Title, working-on line, tokens:** never pushed by the box. The hub recomputes them when a
  history chunk for that session is ingested. It fires the hub change notifier only when one of
  them actually changed, and at most once per box every 30s. The tray refetches on the 15s SSE
  ping anyway, so it does not depend on that notifier.
- **Producers in the box stay cheap.** Plugins and extensions (opencode, pi) already spawn
  `agentbox-ctl` per state change. Nothing new spawns per tool call or per streamed token.

### Data shape

Additive fields on `AgentStatusEntry` (`packages/core/src/sync/agent-status.ts`) and on the Box
payload's `agentStatus[agent]` (`apps/hub/lib/boxes/types.ts`). The schema stays 1, and absent means
"no data", never "zero":

```ts
interface AgentStatusEntry {
  state: AgentActivityState;          // existing
  sessionTitle?: string;              // existing; now the derived title (see Phase 3)
  sessionId?: string;                 // new, box-side (Phase 2)
  activity?: string;                  // new, hub-side: one line, max 120 chars
  usage?: {                           // new, hub-side, for the current session only
    input: number; output: number; cacheRead: number; cacheWrite: number;
    reasoning?: number;
    contextTokens?: number;           // size of the last request's context
    contextWindow?: number;
    costUsd?: number;                 // only when the agent records a cost (opencode, pi)
    updatedAt: string;
  };
}
```

`sessionId` never leaves the hub API as anything but an opaque id; the tray does not use it.

## Phase 0 results (live PoC, 2026-11-24)

One docker box per agent, on `examples/express-ready` and nightly CLI 0.34.0-nightly.202611232201.
Each run did a multi-step change, then a new session with a different prompt, then a rename where
the agent has one. Raw hook and plugin events were captured with project-local debug hooks, and no
shared config volume was changed. All boxes were destroyed afterwards.

| | claude 2.1.325 | codex 0.172.0 | opencode 1.19.6 | pi 1.6.0 |
|---|---|---|---|---|
| **Status source** | hooks (fine), plus a bug | hooks (fine), but the scraper overrides them | plugin is wrong, see bugs | extension events (fine) |
| **Current session id** | ctl pointer; follows `/new` (SessionEnd `clear` then SessionStart `clear`) | hook `session_id`; SessionStart fires only at the first prompt after `/new` or `/resume`, not at the switch | per event `sessionID`; a TUI `/sessions` switch and `/new` emit **no event** | `session_start {reason, previousSessionFile}` on `/new` and `/resume` |
| **Title** | transcript: last `custom-title`, else last `ai-title` (written about 1s after the first prompt), else the first prompt. Also `~/.claude/sessions/<pid>.json` `name` | `~/.codex/session_index.jsonl`: last row for the id. The auto-name arrives 3-6s after the first prompt; a rename appends a row. The rollout never has the name | `session.updated` `info.title`, about 1.7s after the first prompt, immediately on rename. sqlite `session.title` | no automatic titles; `/name` writes a `session_info` entry. Otherwise use the first prompt |
| **Working on** | no todo tool in this build. Use the last `tool_use` (Bash and Agent carry `description`; Edit, Write and Read carry `file_path`), then the last assistant text | last `item_completed` AgentMessage with `phase:"commentary"`, then the last CommandExecution `parsed_cmd`, then the prompt. No plan tool with this model | the in-progress item of `todo.updated`, then the running tool part (tool + short input) | `tool_execution_start {toolName, args}`, then the assistant's preamble text |
| **Tokens** | `message.usage` per assistant line, repeated on every content block of a message, so dedupe by `message.id`. Subagent usage is only in `<sid>/subagents/agent-*.jsonl`. No cost anywhere but the statusLine | rollout `token_count`: `total_token_usage` is cumulative; `last_token_usage.input_tokens` against `model_context_window` gives context fill. Drop `rate_limits`, which is account data | `session.updated` `info.tokens` + `cost`, cumulative per session. Subagent sessions are separate (`parentID`). Cost is 0 on a ChatGPT subscription | `message.usage` per message, including cost. The sum over all entry kinds matches pi's own footer exactly |
| **Pane title** | follows `/new`, but has a `✳ ` prefix and reads `✳ Claude Code` right after `/new` | follows everything instantly, but has a spinner glyph or `[ ! ] Action Required \|` prefix and a ` \| <cwd>` suffix | follows everything (`OC \| <title, cut at about 40 chars>…`) | follows everything (`π - <name> - <cwd>`), but any extension can rewrite it |

**Why the claude title looks frozen.** Claude generates its AI title once per session, from the
first prompt, and never regenerates it. And a `/rename` name carries over into every later session
after `/new` (it is line 1 of the new transcript) and blocks a new AI title. Reading the transcript
gives the title Claude itself shows; the pane title adds the `✳` noise on top.

**Shared volumes.** `~/.claude/projects/-workspace`, `~/.claude/sessions`, `~/.codex`, opencode's
`opencode.db` and pi's sessions folder are each shared by every box on that agent's config volume,
and `~/.codex` also with the host. "The newest file" or "the latest row" is always wrong: every
lookup goes by this box's session id.

### Bugs found

1. **claude stays `working` for about 60s after every turn.** About 0.5s after `Stop`, a hidden
   prompt-suggestion fork fires `SubagentStop` with `agent_type: ""`, and the baked hook maps it to
   `working`. Only the `idle_prompt` notification about 60s later corrects it.
2. **claude's session pointer can be wiped by a race.** The backgrounded `SessionEnd --clear-session`
   can land after the synchronous `SessionStart --capture-session` that follows it.
3. **codex stays `working` after a turn, indefinitely.** In `packages/ctl/src/codex-scraper.ts`,
   `Worked for \d` is the turn-finished footer in 0.172, but it sits in the working rule and
   overrides the Stop hook's idle. The hub's title also carries the raw spinner glyph, so it changes
   on every push.
4. **opencode reports `idle` for most of a busy turn.** The plugin marks working only on
   `message.part.delta`, which fires only while the final text streams: about 47s of a 50s turn
   read `idle`, and a `sleep 25` tool call read `idle` at every poll. A subagent's
   `session.created` and `session.idle` also flip the parent to idle mid-turn.
5. **opencode hides a failed first turn.** An unsupported model fires `session.error`, then
   `session.idle` 2ms later, which overwrites `error`. The `-i` job reports "done" and `agentbox
   list` shows idle; only attaching shows "model is not supported". The trigger is shared:
   opencode falls back to the last-used model in `.state/opencode/model.json`, which lives on the
   shared config volume, so one box's (or the host's) model choice is every box's default.
6. **pi tokens are under-counted in history.** `packages/agent-pi/src/history.ts` counts only
   assistant `message.usage`, and misses toolResult usage, `usage` entries and compaction or
   branch-summary usage.
7. **codex has no `waiting` state in YOLO mode.** `PermissionRequest` never fires; the ask-the-user
   tool is `request_user_input` / `request_user_input_async`, seen only as a `PreToolUse`.

## Phases

Each phase is one session, merged to nightly on its own. Keep `docs/agent-live-status-backlog.md`
live from Phase 1.

### Phase 1: fix status (box-side) — done

**Done (2026-11-24).** Bugs 1-5 and 7 are fixed in the hook, plugin and extension files and in ctl, as listed below, with these specifics: claude's SubagentStart/SubagentStop and SessionEnd buffer their stdin and pass it to `--skip-unnamed-subagent` / a conditional `--clear-session`; codex's request_user_input reports the sticky `question` state (input-needed like `waiting`), so the catch-all `working` for the same call is swallowed, and its PostToolUse leaves it with `--clear-pending` (codex matchers are Rust regexes, with no lookahead to exclude the tool from the catch-all); the opencode plugin and the pi extension send their reports one at a time, so two cannot reach ctl out of order; opencode ignores the `MessageAbortedError` of an Esc interrupt and drops unanswered permissions when the root session goes idle or errors; pi decides `error` at the settle (Pi retries failed requests itself) and keeps `agent_end` as the end of turn until it has seen an `agent_settled`; the opencode plugin and the pi extension carry their mapping as a pure tracker with unit tests (`packages/sandbox-docker/test/agent-state-plugins.test.ts`); the `-i` stay-up probe (`verifyAgentSessionStaysUp`, every provider) reads `agentbox-ctl status --json`, which now lists each agent's last state, and fails on an `error` reported during the launch. The pane-title rules ride `AgentSyncSpec.paneTitle` and `agents.list`.

Fix bugs 1-5 and 7, all in the hook, plugin and extension files and in ctl:

- **claude (`claude-managed-settings.json`):** ignore `SubagentStart`/`SubagentStop` when
  `agent_type` is empty. Make the `SessionEnd` clear conditional: clear the pointer only if it
  still holds that `session_id`.
- **codex:** drop `Worked for \d` from the working rule. Replace the pane-text regex as a safety
  net with the pane-title prefix: a spinner glyph means working, `Action Required` means waiting,
  neither means idle. Map `PreToolUse` with `tool_name` `request_user_input*` to `waiting`.
  Correct the stale "hooks are unreliable" comment.
- **opencode (`opencode-agentbox-plugin.js`):** working = the root session's `session.status`
  busy or retry; waiting = an unanswered `permission.asked`; idle = the root session's
  `session.idle`; error = `session.error`, sticky until the next busy. Ignore sessions that have a
  `parentID`. The `-i` verdict fails on `session.error`.
- **pi (`pi-agentbox-extension.js`):** idle on `agent_settled`, not `agent_end`; waiting on
  `ui_prompt_start`/`ui_prompt_end`; error on an assistant `message_end` with
  `stopReason: "error"`.
- **opencode's shared `model.json` (bug 5):** out of scope here. Record it in the backlog with
  the two options (a per-box `XDG_STATE_HOME`, or pinning a model per box).
- **Pane-title cleanup, as a stopgap until Phase 3:** strip each agent's prefix and suffix (claude
  `✳ `, codex spinner and ` | <cwd>`, opencode `OC | `, pi `π - ` and ` - <cwd>`) and drop the
  placeholders (`Claude Code`, a bare `workspace`, `OpenCode`). Put the rules on the agent's
  registry row and send them over `agents.list`, so a new agent version needs no re-bake.

The hook, plugin and extension files are baked into the image and seeded onto the shared config
volumes, and ctl is baked. So this phase ends with a re-bake on every provider, plus a check that
the seeder refreshes an existing volume's copy.

**Done when:** each agent goes idle within one snapshot (15s) of finishing a turn, opencode reads
working during a tool call, and codex reads waiting on a question. Verify live in a box per agent,
the way Phase 0 did.

### Phase 2: the current session id (box-side) — done

**Done (2026-11-24).** Every `--capture-session` report hands its `session_id` to the reporter, which publishes `agents[<id>].sessionId` (after a daemon restart, claude's resume pointer until the next hook). The hub passes it through on `Box.agentStatus[agent].sessionId`. The opencode pane-title match reads this box's bound root sessions from `opencode.db` (`packages/ctl/src/session-by-title.ts`).

Put `sessionId` on each agent's status entry:

- **claude:** the ctl pointer, which already follows `/new`.
- **codex:** add `--capture-session` to `UserPromptSubmit`, so the pointer moves at the first
  prompt after `/new` or `/resume`. Codex fires no hook at the switch itself, so between the
  switch and that prompt the old id stays. That is acceptable: the new session has no title or
  tokens yet.
- **pi:** the extension's `session_start` already captures it.
- **opencode:** the plugin records the root session that last went busy. A TUI `/sessions` switch
  emits no event, so ctl also matches the cleaned pane title against the titles of the box's
  recent root sessions and prefers a match.

**Done when:** `GET /api/v1/boxes` shows the right `sessionId` for every agent after a `/new` (and
a prompt, for codex) and after a `/resume`.

### Phase 3: title, working-on line and tokens (hub-side) — done

**Done.** What landed:

- Parsers emit three new record kinds (`packages/core/src/history/types.ts`): `activity` (one
  line; a `plan` line from an in-progress todo wins while set), `totals` (the agent's own
  cumulative count: codex `token_count`, opencode's session row) and `context`. Usage records carry
  `costUsd` where the agent records one. Every parser version is bumped, so the existing re-parse
  job re-derives stored sessions; no migration.
- The line is built by `activityLine` / `toolActivity` (`packages/core/src/history/activity.ts`):
  only a call's short named fields (`description`, `command`, `file_path`, `path`, ...), collapsed
  to one line, run through the history redactor, then clipped to 120 chars.
- claude: `ai-title` (a rename wins for the rest of the file), last `tool_use` or assistant text,
  context from the main thread only. Subagent transcripts were already shipped (`sessionFiles`
  includes `<sessionId>/subagents/*.jsonl`), and their usage lands on the parent session.
- codex: `commentary` messages and `exec_command_begin` `parsed_cmd`; `token_count` totals and
  context (`rate_limits` is never projected; the raw archive keeps the line as shipped). Names come
  from `session_index.jsonl` through a new `format: 'jsonl'` row source: the row cursor copies only
  the bound sessions' lines to `agentbox-history/<sessionId>.index.jsonl`.
- opencode: the `todo` table (keyed by `position`, since the cursor reads per session) and tool
  parts; totals and cost from the `session` row's `tokens_*` columns, which count a session alone,
  so subagent sessions stay out of the parent's total.
- pi: usage from every entry carrying one (bug 6), with cost; last `toolCall`, else assistant text.
- Hub: an additive `history_live` table plus `history_usage.cost_usd`; the slice
  `apps/hub/lib/backend/live-status.ts` joins a box to its current session
  (`agentStatus[agent].sessionId`, else the box's latest session: `currentSessionKey`), enriches
  `Box.agentStatus[agent]` with `activity`, `usage` and the derived `sessionTitle`, and fires the
  notifier only on a change of the current session's summary, at most once per box every 30s.

The plan as written:

1. **A hub-side "live summary" per box.** When a history chunk for a box's current session is
   ingested, recompute `{title, activity, usage}` from that session's parsed rows. Store it, and
   fire the notifier per the debounce rules above. The work goes in a new slice,
   `apps/hub/lib/backend/live-status.ts`, not in `hub-backend.ts`.
2. **Each agent's history module grows what it needs**, in `packages/agent-<id>/src/history.ts`:
   - **claude:** read `ai-title` alongside `custom-title` (custom wins). Activity comes from the
     last `tool_use` (`description`, or `file_path`) or the last assistant text. Dedupe usage by
     `message.id`. Include `<sid>/subagents/agent-*.jsonl`. Check whether the shipper already
     ships subagent transcripts.
   - **codex:** activity is the last `commentary` AgentMessage, then `parsed_cmd`. Tokens come from
     the last `token_count`, with `rate_limits` dropped at ingest. For the title, ship
     `session_index.jsonl` rows for this box's session ids, as a row source like opencode's, and
     take the last row per id.
   - **opencode:** add the `todo` table to the registry row's `sqlite` block. Activity is the
     in-progress todo, then the last running tool part. Tokens come from the `session` row; leave
     subagent sessions out of the parent's total, but record them separately.
   - **pi:** fix bug 6 (sum every entry kind that carries `usage`). The title is the last
     `session_info` name, else the first user prompt. Activity is the last `toolCall`, then the
     last assistant text.
3. **Activity is redacted and clipped.** Tool inputs can carry secrets and whole files, so keep
   one line, at most 120 chars, and run it through the history redactor. Never use the content of
   a `write`.
4. **Context fill:** claude uses the last message's input + cache read + cache write; codex uses
   `last_token_usage.input_tokens` / `model_context_window`; opencode uses the last assistant
   `tokens.total`; pi has no transcript field for it (`ctx.getContextUsage()` is extension-only),
   so it is left out.
5. **The derived title replaces the pane title** in `sessionTitle` once the summary has one. The
   cleaned pane title stays as the fallback for a box with no shipped history yet.

**Done when:** for every agent, the Box payload shows a title that changes after `/new` plus a
first prompt, a working-on line during a turn, and token totals that match the agent's own numbers
(pi's footer, claude's per-message usage, codex's `token_count`), all within one ship interval.

### Phase 4: surfaces

**Done (hub web, CLI, docs):** the presentation rules live in `@agentbox/core`
(`sync/live-status-view.ts`: `formatTokenCount`, `liveActivity`, `usageSummary`,
`usageBreakdown`), mirrored client-side in `apps/hub/lib/live-status-view.ts` and held equal by a
parity test. The working-on line shows only while the state is `working`, `waiting` or `question`
(`ls`: only `working`), and only on a running box. The box row shows the title when it differs from
the task, the working-on line and a token figure with a context bar; hover gives the breakdown,
and cost appears only when positive. The box detail has an **Agent session** card. `ls` prints a
`> <agent>: <activity>` line under a working box; `status --inspect` (text and `--json`
`agentLive`) reads the hub row.

- **Hub web:** the box row and box detail show the title, the working-on line and a token figure
  (context fill on hover).
- **Tray:** the box row shows the working-on line under the title, and tokens in the box submenu.
  Update `../agentbox-tray/CLAUDE.md`, since this changes the `/api/v1` Box payload.
- **CLI:** `agentbox ls` adds the working-on line, and `agentbox inspect` adds everything.
- **Public docs:** update the box status page in `apps/web/content/docs/`, and recapture the
  figures that change, per `apps/web/images.md`.

## Open questions

- **claude cost.** The transcript has none. The options: compute it hub-side from tokens times a
  per-model price table, or bake a statusLine wrapper that copies Claude's stdin
  (`cost.total_cost_usd`, which includes subagents) to a file and then runs the user's own
  statusLine. The second changes the user's setup; the first needs prices kept current. Not needed
  for Phases 1-4, which report tokens, not cost.
- **Ship cadence.** The docker host watcher ships every 60s. If that is too slow for the working-on
  line, lower it for boxes whose agent is `working`. Do not add a separate channel.
