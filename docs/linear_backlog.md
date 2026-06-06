# Linear integration — backlog & status

Linear is **Session 2** of the integrations plan (`docs/integrations_backlog.md`).
The shared `@agentbox/integrations` foundation already shipped with the Notion
path (T1–T4, PRs #73–#76). Linear is therefore **descriptor-driven**: one
connector file, an in-box shim, a config flag, a doctor entry, tests, docs — no
surgery to the relay/ctl core (this is exactly the case that validates the
abstraction the Notion work built).

Backend: **`@schpet/linear-cli`** (the `linear` binary), the planned wrapper.
Installed + authed on the host against the **`waldosai`** workspace (admin) for
e2e. v2.0.0 surface (richer than the plan assumed):
`auth issue team project cycle milestone initiative label document api schema`.

## Security notes specific to Linear (drive the allowlist)

- **`linear auth token` PRINTS the raw API token to stdout** — it must never be
  in the shim allowlist or the connector ops, or a box could exfiltrate the
  credential. Same for `auth login/logout/migrate/default`. The only auth op we
  proxy is `auth whoami` (identity only).
- **`issue delete` / `team delete` / `team create` exist** and are destructive —
  keep them OFF the allowlist (start conservative; widen only when a real agent
  flow needs them, and then as *gated* writes).
- **`linear api` is a raw GraphQL endpoint** — a single POST that serves both
  queries (read) and mutations (write). The `api` op is a read passthrough, so
  it needs a `refuseCall` that rejects any GraphQL **mutation/subscription**
  operation (the GraphQL analogue of Notion's `refuseApiNonGet`), so the "read"
  classification isn't a hole. Writes must go through the dedicated gated ops.
- Credentials live plaintext at `~/.config/linear/credentials.toml` (keyring is
  opt-in, not used) → carries cleanly into a box; **no `LINEAR_*` keyring env
  toggle needed** (unlike `ntn`'s `NOTION_KEYRING=0`). Carry entries added to
  `agentbox.yaml`.

## Proposed connector surface (the implementing box refines this)

| op | read/write | host argv | notes |
|---|---|---|---|
| `whoami` | read | `auth whoami` | identity only — **never** `auth token` |
| `issue.list` | read | `issue list` | a.k.a. `mine` |
| `issue.view` | read | `issue view` | |
| `issue.query` | read | `issue query` | structured filters |
| `team.list` | read | `team list` | |
| `api` | read | `api` | `refuseCall` rejects GraphQL mutation/subscription |
| `issue.create` | write (gated) | `issue create` | |
| `issue.update` | write (gated) | `issue update` | status/title/etc. |
| `issue.comment` | write (gated) | `issue comment create` | |

## Tasks

### LT1 — Connector + shim + config + doctor + unit tests + docs  — **status: not started**
- `packages/integrations/src/connectors/linear.ts` (+ register in `registry.ts`;
  widen the `IntegrationService` union in `types.ts` to include `'linear'`).
- `refuseGraphqlNonQuery` (or similar) for the `api` op — refuse mutation/subscription.
- `packages/sandbox-docker/scripts/linear-shim` — strict allowlist mirroring
  `ntn-shim`; rejects `auth token` and everything off-list. Installed as
  `/usr/local/bin/linear`. Wire into `stage-runtime.mjs` (contextFiles +
  execBitFiles + all provider lists), `Dockerfile.box` COPY, and the hetzner
  `install-box.sh` mirror.
- `integrations.linear.enabled` typed config flag (default false) in
  `packages/config/src/types.ts` (+ defaults + the CONFIG_KEYS metadata entry).
- `agentbox doctor` already iterates `ALL_CONNECTORS` — Linear should appear for
  free once registered; verify and adjust if needed.
- Unit tests (pure): registry resolves linear; ops classified read/write;
  `api` refuses a mutation but allows a query; shim allowlist rejects `auth token`.
- Docs: `docs/integrations.md`, the public `.mdx` page(s), `docs/host-relay.md`
  (new methods), `docs/features.md`, CLI reference — same set the Notion path
  touched.
- `pnpm typecheck && pnpm test && pnpm build` green → `/simplify` → `/review high`
  → PR into `add-ticketing-integrations` → fix bugbot → merge.

### LT2 — Live e2e against Waldosai + nested-box best-effort + closeout  — **status: not started**
- Orchestrator prep (host): rebuild + restart relay with LT1 merged; set
  `integrations.linear.enabled=true` in host project config.
- Primary e2e from inside a box: `linear whoami` (read, no prompt) → `linear
  issue list` (read) → `linear api '<query>'` (read) → `linear issue create …`
  (write → host approval prompt → orchestrator approves → issue created) →
  verify via read → `issue update` to mark/close the test issue → **no-token
  assertion** (`printenv | grep -i linear` shows only `AGENTBOX_RELAY_TOKEN`).
  Verify ground truth, never trust exit codes.
- Best-effort nested-box e2e (time-boxed): install `linear` in the box, rely on
  the carried `~/.config/linear/credentials.toml`, create a nested box, enable
  the flag, run a read + gated write from the nested box (this box's relay gates
  it). Document the limitation if too fragile.
- Fix any bug the e2e surfaces (keep tight).
- Close out: mark the **Linear** path done in `docs/integrations_backlog.md`
  with evidence; update this file's status log.
- Green → `/simplify` → `/review high` → PR → fix bugbot → merge.

## Status log

- 2026-06-06: Backlog created. Host `linear` (@schpet/linear-cli@2.0.0) verified
  authed against `waldosai` (admin, accounts@waldos.ai). Connector surface
  scouted; security notes captured (auth-token leak, destructive deletes,
  GraphQL mutation gate). Linear carry entries added to `agentbox.yaml`.
</content>
</invoke>
