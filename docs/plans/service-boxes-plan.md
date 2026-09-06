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

### Blocking — OpenClaw is not usable without these

1. **The published URL does not serve on cloud providers.** The box's own
   Portless proxy owns `:80`, so ctl's WebProxy cannot bind `expose:`;
   `web-proxy.log` records `listen :80 failed: EADDRINUSE` and the create still
   reports ready and prints a dead URL. Route `expose:` **through** Portless
   rather than racing it — `AGENTBOX_WEB_PROXY_PORT` (Vercel uses 8080) is the
   existing seam — and make a failed bind for an exposed service loud.
2. **Cloud boxes ignore the workspace.** `spec.boxRunEnv` does not reach the ctl
   tasks, so `OPENCLAW_WORKSPACE_DIR` is absent and onboard runs against
   `~/.openclaw/workspace`. "Your project dir is the agent's workspace" — the
   headline behaviour — is broken off docker.
3. **The non-git cloud seed writes AppleDouble sidecars.** `seedCloudWorkspace`
   tars the host dir without `COPYFILE_DISABLE=1`. The three docker-side call
   sites are fixed; this is the fourth.
4. **The hub cannot build a service-agent box.** The queue worker fails with
   `unknown agent kind`, while `GET /api/v1/agents` already offers openclaw — so
   the web and tray pickers show it and selecting it fails. Teach the worker, or
   mark it CLI-only until then.
5. **Channel pairing has never been verified.** Every smoke stops at a healthy
   gateway with **zero channels**. Until a real token goes through
   `openclaw channels add --use-env`, we do not know openclaw does anything
   useful in a box. This is the last open question about whether the feature
   works, not a polish item — do it first.

### Rough edges

6. `agentbox-ctl reload` does not re-run a service agent's render, so editing
   the `openclaw:` overlay needs `run-task openclaw-render --force` — which
   contradicts the docs.
7. `agentbox list`'s AGENT column is blank for a service box: it probes a tmux
   session that does not exist. Read the ctl service state for
   `caps.surface: 'service'`.
8. `<agent> stop` bypasses the hub via `provider.exec` — the services routes
   expose `restart` but not `stop`.

### Hygiene

9. `--allow-scripts=openclaw` leaves four **dependency** install scripts unrun,
   two of them native (`koffi`, `tree-sitter-bash`). Unknown whether anything
   depends on them until a channel exercises it — check alongside (5).
10. `agentDirPrelude`'s creds-subdir is a hand-typed string never checked against
    `credential.cloudSubpath`; `CLAUDE_HOST_BACKUP` resolves to `''` at module
    load if claude ever drops its credential.
11. DigitalOcean and remote-docker are unexercised. remote-docker is the main
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
