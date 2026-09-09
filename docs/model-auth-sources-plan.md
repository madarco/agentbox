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
| 3 | **env sources: make the existing spray a grant** | **not started** |
| 4 | **multi-select through the four front-ends** | **schema done, renderers not started** |
| 5b | `--model-auth` on `agentbox create` (box-wide) | **not started** |

Phases 1, 2 and 5a are live-verified: `agentbox pi --model-auth codex` seeds the
login, imports it as `openai-codex`, and the box answers a real turn.

## Phase 3 — the remaining work

Move each spec's provider keys out of `forwardedEnvKeys` (which keeps only
non-secret passthrough like `ANTHROPIC_MODEL`) and into `modelAuth.sources`,
then filter the forwarding sites by the box's grant. This must be ATOMIC: a key
that is a source but still in `forwardedEnvKeys` would be both granted and
sprayed, and one removed from `forwardedEnvKeys` before the grant plumbing
exists would make boxes lose keys they have today. `model-auth.test.ts` asserts
a key is never both.

The forwarding sites are ~10, in four agent packages each iterating a
hand-copied constant (`agent-claude/src/docker-sync.ts:482`, `agent-codex:505`,
`agent-opencode:225`; only `agent-pi:46` derives from the spec) plus
`buildForwardedEnv` in `sandbox-cloud/src/sync/agent-credentials.ts:253`.
Preserve the isolation rule documented there: per agent, never the union.

Persist the grant as `BoxRecord.modelAuthSources` **beside**
`borrowedCredentials`, not instead of it — the credential fan-out matches that
field against agent ids (`agent-propagate.ts:306`).

**No "my box lost its key" regression**: `env` sources default ON. The prompt's
`defaultValue` and its non-interactive `fallback` both already carry every
declared env key the host holds, so today's behaviour is what you get by not
reading — only now visible and revocable. `agent` sources stay opt-in.

### Considered and deferred

Moving env values into a 0600 `~/.agentbox/model-auth.env` sourced by a launch
wrapper. A real hardening — secrets leave `docker inspect` and the host's `ps`
argv — but it rewrites five launch sites and regresses a hand-run `pi` inside
`agentbox shell`, which inherits the key today. Orthogonal to "let the user
pick", and easy to add later since the grant is already the input either way.

## Phase 4 — the remaining work

The schema is in place: `multiple?: boolean` on a `select` (not a fourth
`PromptKind`, so a client that has never heard of it renders a plain single
select and posts one value — the n=1 encoding of the same answer),
`exclusive?: boolean` on a choice, `credential-list` detail, and
`encodeMultiAnswer`/`decodeMultiAnswer`.

`buildModelAuthPrompt` already emits a `multiple` select with a
`credential-list` once a row has two or more satisfiable sources; with exactly
one `agent` source it emits the yes/no it always did, so openclaw's surface is
untouched and no renderer needs to change until Phase 3 lands.

Renderers still to do: `ask-clack.ts` (cli-kit already exports `multiselect`),
`prompt-view.tsx` (checkboxes + confirm; and a `key` on `<PromptView>` in
`create-box-modal.tsx`, or React reuses the instance across the queue and the
second prompt opens with the first's boxes ticked), and the tray's
`Prompt.swift` / `PromptCard.swift` / `CreateBoxPanel.swift`.

**The hard constraint**: the shipped tray decodes the existing `credential`
detail with a plain `try` over non-optional `hostPath`/`boxPath`
(`Prompt.swift:128`). An env-backed source has neither, so it must never be sent
through that variant — a shipped tray would fail the whole preflight decode and
show NO prompts. Hence `credential-list` is a new `type`, and the n=1 `agent`
case keeps emitting `credential`.
