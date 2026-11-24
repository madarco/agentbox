# Agent live status: backlog

Open items for [`agent-live-status-plan.md`](./agent-live-status-plan.md), kept live while the
phases land.

## From Phase 3 (hub-side)

- **Codex session names need a re-bake.** The `format: 'jsonl'` row source lives in `@agentbox/core`,
  which ctl inlines, so a box's ctl reads `session_index.jsonl` only after a re-bake on every
  provider. An older ctl receives the new codex source over `history.config`, tries to open the
  file as a sqlite db, and records an error for that source on every pass (opencode and openclaw
  are unaffected). Until then a codex box's title falls back to its first prompt.
- **The `sessionId` fallback.** `currentSessionKey` falls back to the box's most recent session of
  that agent while ctl reports no `sessionId` (Phase 2). It prefers sessions with no parent, so a
  claude `/branch` session is never picked by the fallback. Drop the fallback once every supported
  box reports `sessionId`.
- **The `seen` map in the slice is unbounded.** One small fingerprint per session ever ingested
  while the hub runs. Prune by age if a long-lived hub shows it.
- **The Postgres box source** (`apps/hub/lib/boxes/postgres-source.ts`, the hosted plane path) does
  not enrich `agentStatus`: it has no history store.
- **Cost for claude** is still absent (the plan's open question).
- **opencode tool parts settle for 20s** before the cursor copies them, so opencode's working-on
  line lags more than the other agents'. The in-progress todo is copied without a settle delay.
- **Ship cadence.** The docker host watcher ships every 60s, so a docker box's working-on line can be
  a minute old. Lowering it for `working` boxes is the plan's open question.
