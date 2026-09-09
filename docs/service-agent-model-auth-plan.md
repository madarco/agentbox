# Service-agent model auth: borrowing the host's Codex login

**Status: done** (2026-09-09). Codex only; Anthropic out of scope by decision.

An `agentbox openclaw` box used to come up with a gateway identity and no model
provider. It can now be seeded with the Codex (ChatGPT subscription OAuth)
login the host already holds: `--model-auth codex`, the `openclaw.modelAuth`
config key, or a TTY prompt defaulting to no.

## The shape

One new registry field, `AgentSyncSpec.modelAuth`:

```ts
modelAuth: {
  borrows: [{ agent: 'codex', label: 'your Codex login (ChatGPT subscription OAuth)' }],
  ingestTask: 'openclaw-model-auth',
}
```

| who | does what |
|---|---|
| host, at create | validates the request against `borrows` (`resolveBorrowedCredentials`), picks the freshest valid host file (`resolveHostCredentialFile`: freshness rule if declared, else mtime), and lands it at the LENDER's own `credential.boxAbsPath`, 0600, as one more carry entry (`borrowedCredentialCarry`) |
| box, first boot | `openclaw-model-auth` (a `service.tasks` entry on OpenClaw's row) installs the official `@openclaw/codex` plugin if absent and runs `openclaw migrate apply codex --from ~/.codex --include-secrets --item auth:openai --yes`, then records `sha256(seed)` in `~/.openclaw/.agentbox-model-auth.sha256` |
| box, later boots | same task, no-op while the seed's hash matches the marker |
| host, fan-out | `planPropagateTargets` lists boxes whose `borrowedCredentials` includes the agent; `credentials propagate` pushes over the transport and re-runs the ingest task, which re-imports only if the file changed |
| clone | `prepareClone` carries the source's `borrowedCredentials`; the clone borrows afresh from the host, never the source box's session |

AgentBox never learns OpenClaw's auth format. Borrowing is one-way: `box.agents`
still gates extraction, the resume reconcile and the credential watch.

Docker's carry step moved ahead of the ctl daemon launch, where its own
comment always said it belonged: after the daemon, a first-boot task that reads
a carried file raced it. Cloud creates already ran carry before the bootstrap.

## What the PoC measured (openclaw 2026.9.3 in a box, 2026-09-09)

1. **The auth store is SQLite** (`agents/<id>/agent/openclaw-agent.sqlite`).
   The retired `auth-profiles.json` / `credentials/oauth.json` are never read
   at runtime; `doctor --fix` migrates them once. Writing one is not a seam.
2. **`migrate apply codex --item auth:openai` is the supported import**, and
   lives in the official `@openclaw/codex` plugin from ClawHub (not stock).
   That plugin is also the harness the fresh onboard's default model
   (`openai/gpt-5.6-sol`) already points at, so installing it completes the
   default rather than changing it. ~15s, once per box, into the config volume.
3. **A bare `~/.codex/auth.json` is a trap.** `models status` shows a
   bootstrapped `openai:default`, `source: store`, status `ok` — and a turn on
   it fails with `selected_auth_profile_unavailable`. OpenClaw's status view
   therefore cannot say "already imported"; the gate is the seed's hash.
4. **Rotation does not invalidate the previous refresh token.** Box 1 imported
   the host file and refreshed (R0 -> R1). Box 2 imported the same host file
   thirteen minutes later and refreshed from R0 successfully (R0 -> R2). Box 1
   then refreshed again (R1 -> R3). Every chain, the host's included, stayed
   valid. So a seeded box is an independent session; no reverse sync, no
   freshness fan-out is needed for correctness.
5. **The gateway needs no restart** on first boot: the ingest task is ordered
   before the gateway (`needs`), so the plugin it installs is loaded on the
   gateway's first start.
6. **The import applies on every run** (no built-in idempotency), which is the
   other reason for the hash gate: a re-import would replace the box's own
   newer chain with the seed's.

## Deliberately not done

- Borrowing claude's `.credentials.json`: a refresh by the consumer rotates the
  refresh token and logs out the host and every claude box (`docs/agents.md`,
  "rotates the refresh token"). API keys already reach the gateway through the
  0600 per-box `.env` carry.
- Any token in the `openclaw:` overlay or in container env; `forwardedEnvKeys`
  stays empty.
- Mounting codex's config volume into the OpenClaw box.
- Re-seeding on `start` / resume: the box owns its session after import.

## Verified live

- `agentbox openclaw -n oc-borrow --model-auth codex -y`: seed logged, plugin
  installed, import ran, marker written, gateway ready, `openclaw agent
  --message` answered on `gpt-5.6-sol` via the Codex subscription.
- Warm boot: task logs "already imported", 14ms.
- `agentbox credentials propagate --agent codex`: `pushed codex credential to
  oc-borrow (borrowed)`, ingest re-run, no-op on identical content.
- `BoxRecord.borrowedCredentials` and `GET /api/v1/boxes[].borrowedCredentials`
  both `['codex']`.
- The TTY prompt renders with No selected (drive harness).

## Known gap

`agentbox openclaw -n <new>` reuses the project's existing OpenClaw box instead
of creating the named one (`findExistingBox` matches on workspace + agent and
ignores `-n`). Pre-existing; noted, not changed here.
