# Service boxes — what is left

Status: **phases 0-8 shipped and merged** (persistent boxes, the service-agent
surface, layered config, workspace upload/download/clone, and OpenClaw as the
first service agent). What remains is finishing **OpenClaw support**.

The long-form plan that produced those phases is in the git history of this
file; the per-phase findings live in
[`service-boxes-backlog.md`](./service-boxes-backlog.md). Kept below is only
what still constrains the work.

---

## Established facts

Measured, not assumed — against openclaw 2026.8.2+ on a real box. Each one
closes a design question, so re-opening one needs new evidence, not an opinion.

| Fact | Consequence |
|---|---|
| The gateway binds **loopback** and **self-generates its auth token** at onboard | No `gateway.bind` override, no injected secret, no baked base config. ctl's WebProxy reaches it inside the box. |
| `openclaw config patch --stdin` is a **validated recursive merge** with `--dry-run`, and leaves keys it is not given alone | AgentBox never parses or rewrites `openclaw.json`. `agent render` sends only the overlay keys that changed since its last apply. |
| `openclaw config get gateway.auth.token` returns `__OPENCLAW_REDACTED__` | `<agent> url` reads the token from the raw JSON file. |
| Install is **~893 MB** | On demand, never baked into a base variant. |
| Two fresh onboards produce **different gateway tokens** | `clone`'s fresh identity needs nothing more than not copying the state dir. |
| openclaw has **no host-side credential** | `AgentSyncSpec.credential` is optional; pointing it at `openclaw.json` would fan a gateway identity out to every box. |
| `~/.openclaw/tmp/openclaw-<uid>/` is uid-keyed | Excluded — the box user's uid differs per provider. |

---

## What is left

Re-checked against the code and live Hetzner boxes on 2026-09-07. The URL, the
hub-create, the cloud workspace-env and the AppleDouble blockers are **done**;
what follows is what actually remains.

### Blocking — OpenClaw is not usable without these

1. **Channel pairing has never been verified.** Every smoke stops at a healthy
   gateway with **zero channels**. Until a real token goes through
   `openclaw channels add --use-env`, we do not know openclaw does anything
   useful in a box. This is the last open question about whether the feature
   works, not a polish item — do it first.
2. **The Control UI cannot connect on a public-preview provider.** e2b and
   vercel serve `/` fine (their edges add no forwarded headers), but the WS
   connect is refused with "Browser origin not allowed" until the box's own
   origin is in `gateway.controlUi.allowedOrigins`. AgentBox knows that origin
   at create; it needs somewhere to assert a config key it owns. Setting it by
   hand reaches the normal "paste the gateway token" state, so nothing else is
   wrong. See the backlog for the measurement.
3. **A fresh box needs `openclaw doctor --fix`** before any CLI command that
   touches exec approvals works. The gateway is unaffected; whether the runtime
   approvals path is too is unknown — check it alongside (1). See the backlog.

### Rough edges

5. `agentbox-ctl reload` does not re-run a service agent's render, so editing
   the `openclaw:` overlay needs `run-task openclaw-render --force` — which
   contradicts the docs.
6. `agentbox list`'s AGENT column is blank for a service box: it probes a tmux
   session that does not exist. Partly self-fixing now that `attach` creates one
   (`service.repl`), but only once someone has attached — read the ctl service
   state for `caps.surface: 'service'` instead.
7. `<agent> stop` bypasses the hub via `provider.exec` — the services routes
   expose `restart` but not `stop`.

### Hygiene

8. `--allow-scripts=openclaw` leaves four **dependency** install scripts unrun,
   two of them native (`koffi`, `tree-sitter-bash`). Unknown whether anything
   depends on them until a channel exercises it — check alongside (2).
9. `agentDirPrelude`'s creds-subdir is a hand-typed string never checked against
   `credential.cloudSubpath`; `CLAUDE_HOST_BACKUP` resolves to `''` at module
   load if claude ever drops its credential.
10. DigitalOcean and remote-docker are unexercised. remote-docker is the main
    consumer of the non-git sync leg (a bind mount cannot cross a network).

---

## Verification

Docker is green end to end today; the gap is cloud. Start slow commands in the
background and tail `~/.agentbox/logs/latest.log` rather than picking a timeout.

```sh
# docker — the reference behaviour
cd examples/openclaw-gateway            # copy it out first; see its README
agentbox openclaw -y -n claw
agentbox openclaw status claw           # service `ready`, not `running`
curl -fsS "$(agentbox openclaw url claw | head -1)/healthz"   # ground truth

# the overlay is the point: change one key, re-render, and confirm an in-box
# hand edit to a DIFFERENT key survives
agentbox shell claw -- agentbox-ctl run-task openclaw-render --force

# cloud — blockers 1-3 all show here
agentbox openclaw --provider hetzner -y -n clawhz
agentbox shell clawhz -- bash -lc 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18789/healthz'
agentbox shell clawhz -- bash -lc 'sudo tail -3 /var/log/agentbox/web-proxy.log; ls -a /workspace'
```

A box reaching `ready` proves the gateway bound a port and nothing more — see
the "cloud box usable, not just ready" lesson. Verify a real channel.
