# Model-auth sources — plan and status

## Why

`agentbox` can seed a box with a model-provider login the host already holds.
Until this change that was one hardcoded path: only **openclaw** could receive
one, only **codex** could lend one, only **one** could be chosen, and the flag
existed only on service-agent commands. Meanwhile a second, invisible mechanism
already shipped — `forwardedEnvKeys` sprays every declared provider API key
present in the host env into every box, unasked and unlogged.

The goal is one picker over everything the host can lend, for every agent:
*"which of your model-provider logins should this box get?"*

## The model

`AgentSyncSpec.modelAuth` is `{ sources, ingest? }`.

A **source** is one of two kinds:

| kind | what it is | how it reaches the box |
|---|---|---|
| `agent` | another agent's host-held `credential` FILE | carried to the LENDER's own `credential.boxAbsPath`, 0600 |
| `env` | a provider API key in the host environment | forwarded into the box's env |

`modelAuthSourceId` gives each a stable id: an agent id bare (`codex`), an env
key prefixed (`env:XAI_API_KEY`). Agent ids never contain `:`, so every existing
`--model-auth codex` invocation and stored config value keeps working verbatim.

An **ingest** turns a seeded FILE into the consuming agent's own store. An `env`
source needs none — the key IS the auth.

| shape | who | why |
|---|---|---|
| `serviceTask` | openclaw | an entry in its own `service.tasks`, ordered in its DAG |
| `command` | pi, opencode | the HOST runs it at the launch seam |

A TUI agent must use `command`: it has no supervisor unit to hang a task on, and
ctl's wire cannot express a task without a service (`agentUnitsFromWire` returns
`null` unless `service.name` and `service.command` are both valid) — and that
narrowing lives in a BAKED binary, so a new branch there would be silently
skipped by every box built from an existing image or snapshot.

## Measured facts that decide the design

1. **OpenAI does not invalidate a prior refresh token on rotation.** Each seeded
   box is an independent session; no reverse sync is needed.
2. **A consumer cannot refresh a codex-issued token.** pi returns
   `invalid_state` for one while refreshing its own fine (verified back to back
   in one isolated HOME). So a mapped profile must carry the real expiry off the
   access token's `exp` claim — never 0, never a past value.
3. **Therefore a seeded box cannot renew itself.** Its only renewal path is the
   credential fan-out re-pushing the host's refreshed login, which re-runs the
   ingest because the seed's hash changed. Every ingest gates on a hash of the
   SEED for that reason.
4. **Claude's live OAuth blob stays non-borrowable.** A consumer's refresh
   rotates the refresh token and logs the host and every claude box out. An
   Anthropic API key is the safe `env` source instead.

## Phase status

| phase | what | status |
|---|---|---|
| 0 | prove pi/opencode can consume a borrowed Codex login | **done** — both completed real turns |
| 1 | the source model in `@agentbox/core` + registry data | **done** |
| 2 | ingest runner + the three launch seams | **done** |
| 5a | `--model-auth <source...>` on every declaring agent; `enum-list` config | **done** |
| 3 | ~~env sources~~ | **dropped** — copying an API key by hand is not a real burden, and it is not worth rewiring ~10 forwarding sites for |
| 4 | multi-select through the front-ends | **schema + CLI renderer done and drive-verified, but UNREACHED** — the model-auth prompt is a one-pick list; web/tray renderers not started |
| 5b | `--model-auth` on `agentbox create` (box-wide) | **done** — see below |

Phases 1, 2 and 5a are live-verified: `agentbox pi --model-auth codex` seeds the
login, imports it as `openai-codex`, and the box answers a real turn.

## Phase 5b — `agentbox create`

`agentbox create` builds an AGENTLESS box, so the question "which source?" has no
row to answer it. The shape that falls out of the model rather than fighting it:

- **A source names the LENDER, never the consumer.** That is already true
  everywhere (`modelAuthSourceId` is the lending agent's id), so an agentless box
  can be given one with no new concept: `borrowedCredentialCarry` only ever
  needed the lender list, and it lands the login at the LENDER's own
  `credential.boxAbsPath`, 0600.
- **The legal ids are the union of the `agent` sources the registry declares**,
  not "every agent with a credential file". A box may only be seeded with a login
  some agent is known to be able to consume — which is also what keeps claude's
  OAuth blob out (measured fact 4). Today that set is exactly `codex`.
- **Explicit or nothing.** There is no agent, so there is no `<agent>.modelAuth`
  to default from and no `promptOnCreate` row to ask. No new config key either:
  a box-wide one would be a second way to say what the agent keys already say,
  on a command that makes one box.
- **An `env:` id is REFUSED, not ignored** — phase 3 was dropped, so nothing
  would consume it, and accepting it would promise a seed that never happens.
  An id no agent declares is refused the same way, naming what is accepted.
- **When the box later gets an agent, it just works**, and this is the part that
  makes the flag worth having: `provider.create` records
  `box.borrowedCredentials`, and every agent start seam (`start-attach.ts`,
  `agent-sessions.ts`, the queue worker, `startDetachedCloudAgent`) already
  re-runs the hash-gated ingest whenever that list is non-empty. So
  `agentbox create --model-auth codex` then `agentbox pi <box>` imports the login
  at pi's first start with no second decision — and an agent that declares no
  ingest simply finds the file at its canonical path.

The refusals are the interesting half: the failure this feature exists to end is
a silently dropped source, so `create` says no rather than seeding nothing.

## Phase 3 — dropped

Turning `forwardedEnvKeys` into a grant was cut: copying a provider API key into
a box by hand is not a real burden, and it is not worth rewiring ~10 forwarding
sites in four agent packages for. Those keys keep reaching boxes exactly as they
do today, unconditionally.

The `env` source KIND stays in the schema — it costs nothing, the gate and the
picker already handle it, and it is the only shape that could ever express a
provider with no agent behind it (xAI). Nothing declares one.

Consequence worth knowing: with no env sources declared, every agent has exactly
ONE source (`codex`), so the gate always takes the single-`agent`-source branch
and asks a plain yes/no. The multi-select is reachable only once a row declares
a second source.

## Phase 4 — done, and currently unreached

The schema carries `multiple?: boolean` on a `select` (not a fourth
`PromptKind`, so a client that has never heard of it renders a plain single
select and posts one value — the n=1 encoding of the same answer),
`exclusive?: boolean` on a choice, a `credential-list` detail, and
`encodeMultiAnswer`/`decodeMultiAnswer`. `ask-clack.ts` renders it, verified
through `pnpm drive`: ticking two options yields `codex,claude`, an empty
submit yields `none`.

**Nothing emits it.** The model-auth question is deliberately a one-pick list —
a box runs on one model provider — so `multiple` waits for a prompt that
genuinely wants several. It is tested, so it will not rot.

If something does emit one, the web and tray renderers have the degradation the
CLI just lost: they answer immediately on click, so the user could pick only
one. Valid, but not what was asked.

**The hard constraint if that day comes**: the shipped tray decodes the existing
`credential` detail with a plain `try` over non-optional `hostPath`/`boxPath`
(`Prompt.swift:128`). A source with neither must never be sent through that
variant — a shipped tray would fail the whole preflight decode and show NO
prompts. Hence `credential-list` is a separate `type`, and the single-`agent`
case keeps emitting `credential`.

## Who asks

`promptOnCreate` on the row, opt-in, set by **openclaw alone**. A coding agent
has its own sign-in; a service agent has no TUI to sign in through. `pi` and
`opencode` keep the full capability — `--model-auth codex`, `pi.modelAuth`, the
ingest, the fan-out — they simply never prompt.
