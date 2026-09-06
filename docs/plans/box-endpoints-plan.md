# Multiple named endpoints per box

## Context

Two problems, one shape.

**The OpenClaw dashboard is unreachable on cloud providers.** OpenClaw's Control UI
*is* the box's web URL (`expose: { port: 18789, as: 80 }`). On Hetzner and
DigitalOcean the box runs its own in-box Portless proxy, which holds `:80` for the
http→https redirect, so ctl's `WebProxy` loses the race: `web-proxy.log` records
`listen :80 failed: EADDRINUSE` and **everything continues** — create says "ready"
and prints a URL that 302s into Portless and 404s. This is blocker #1 of
`docs/plans/service-boxes-plan.md`.

**A box can publish exactly one port.** `packages/ctl/src/config.ts:835-840` refuses
a second `expose:`, and `:540-546` pins `expose.as` to 80. So a box that runs an app
*and* an admin dashboard, or a t3code/Hermes backend beside its own UI, can surface
only one of them. Everything downstream then re-collapses even what does exist: the
`BoxEndpoints` array is already plural and already rendered by `agentbox inspect` /
`status` / `dashboard`, but `apps/hub/lib/hub-backend.ts:358-359` reduces it to two
scalars with a pair of `.find()` calls, and the hub UI, the tray and `agentbox list`
read only those. The tray can therefore only ever say "Open Web".

The outcome we want: a box declares as many exposed services as it likes, each keeps
a **name and a human label**, every front-end lists them, and the tray shows
"Open Dashboard" for OpenClaw.

## Established facts

Measured against the code, not assumed. Three change the design.

| Fact | Consequence |
|---|---|
| Only **hetzner** and **digitalocean** implement `startInBoxPortless`, and neither sets `webProxyPort` (so it is 80) | The `:80` collision is exactly those two providers. Vercel/E2B already run the WebProxy on 8080 and are immune. |
| `readExposedServicePorts` (`packages/sandbox-cloud/src/expose-ports.ts:18`) already returns **all** `services.*.expose.port`, and cloud already mints one preview URL per port into `cloud.previewUrls` | Multi-port is half-built on cloud. It is names, not URLs, that are missing there — endpoints are called `service-<port>` because the record has no name→port map. |
| Provider port reach: daytona / e2b / hetzner / digitalocean = **any port, any time**; vercel = **max 4, fixed at create, <1024 rejected** (1 free slot); docker + remote-docker = **fixed at `docker run`** | Only vercel needs a "too many" story. Docker's constraint is real but create-time-solvable. |
| `docker run -p` is immutable, and remote-docker already errors clearly for a port added after create (`packages/sandbox-remote-docker/src/backend.ts:627-637`) | Publishing exactly the declared ports at create has precedent, and a precedent for the error text. |
| `BoxStatus` is schema 1 and grows additively by design (`packages/core/src/sync/agent-status.ts:25-30`); `services[].expose` already rides it | Names and labels reach the host with no new wire shape and no version bump. |

## Model

`expose:` becomes plural, with one **primary**.

- Any number of services may `expose:`.
- `as` keeps its meaning — *the reserved container port 80* — but stops defaulting.
  The service with `as: 80` is the primary and owns the box's `webUrl`. If none sets
  it, the first declared expose is the primary implicitly. **Two services setting
  `as: 80` is the new error**, replacing "at most one service may set expose:".
  Every existing `agentbox.yaml` keeps working byte-for-byte.
- `label:` is a new optional string, defaulting to the service name. It is what a
  front-end renders: "Open Dashboard", not "Open Openclaw".
- Extras need **no in-box proxy**: on docker their container port is published
  directly, on cloud they already get their own preview URL. The `WebProxy` stays a
  single-target forwarder for the primary — no change to `web-proxy.ts`'s design.

## Phases

Three PRs against `feat/peristent_agents`, each built and smoke-tested in its own box
per the established pattern. Merge **PR #366 first** — it is green and mergeable but
carries one unfixed Bugbot finding (a TUI *plugin* agent gets a box created, then the
session dispatch throws `unknown agent kind` and leaves it orphaned;
`_run-queued-job.ts:444-496` and `:688-710`).

### Phase A — make the dashboard serve (small, unblocks OpenClaw)

1. Give hetzner and digitalocean `webProxyPort: 8080` on their `CloudBackend` rows
   (`packages/sandbox-hetzner/src/backend.ts`, `packages/sandbox-digitalocean/src/backend.ts`),
   the same declaration vercel makes at `packages/sandbox-vercel/src/backend.ts:300`.
   It flows automatically: `AGENTBOX_WEB_PROXY_PORT` into the box
   (`packages/sandbox-cloud/src/bootstrap-launch.ts:107,130` → `packages/ctl/src/commands/daemon.ts:74-76`),
   `opts.webPort` into the in-box `portless alias` (`sandbox-hetzner/src/backend.ts:866`),
   and the host-side SSH forward via `box.cloud.webPort`. Portless keeps `:80`/`:443`;
   ctl gets 8080. Existing records keep their stored `webPort`, so no migration.
2. **Make a failed bind loud.** `WebProxy` swallows its `error` event
   (`packages/ctl/src/web-proxy.ts:60-64`). Record the failure and report it on the
   status snapshot (`webProxy?: { port, target, error? }` on `BoxStatus`), so
   `<agent> url` / create warn instead of printing a dead URL. This is the general
   fix — the port change alone would leave the next collision just as silent.
3. Verify on a **real Hetzner box**, not a unit test: this bug is invisible to unit
   tests by construction.

### Phase B — multiple exposed services

4. **ctl** (`packages/ctl/src/config.ts`): `ExposeSpec` gains `label?`; `as` becomes
   non-defaulting; the `>1 expose` rule at `:835-840` becomes a `>1 primary` rule;
   `parseExpose` keeps rejecting `as` values other than 80. Update
   `packages/ctl/schema/agentbox.schema.json` in the same change.
5. **Agent units** (`packages/ctl/src/agent-units.ts:217,240-246`): today an agent's
   `expose:` is *dropped* when the workspace yaml already exposes something. It
   becomes a demotion — the agent's expose stays, as an extra, and only the primary
   slot is contested. Mirror `label` through the wire shape
   (`AgentServiceExpose`, `packages/core/src/sync/agent-spec.ts:310`).
6. **Status snapshot** (`packages/ctl/src/status-reporter.ts:245-251`,
   `packages/ctl/src/types.ts:119-123`): carry the full expose spec including
   `label` and which one is primary. Additive; schema stays 1.
7. **One shared reader.** Widen `readExposedServicePorts` into `readExposedServices`
   returning `{ name, port, as?, label? }[]` and **move it down** to
   `@agentbox/sandbox-core` — sandbox-docker now needs it and the dep direction is
   `sandbox-cloud → sandbox-docker`. Re-export from `@agentbox/sandbox-cloud` so its
   current callers are untouched.
8. **Docker publishes the declared ports** (`packages/sandbox-docker/src/create.ts:901`):
   alongside `80`/`6080`/`22`, one `-p 127.0.0.1:0:<port>` per declared expose, merged
   with the resolved agent spec's own exposes (create already knows `agents`). Record
   the container→host map on `BoxRecord` (`extraHostPorts?: Record<number, number>`,
   shaped like `cloud.previewUrls`) and re-resolve it on start beside the existing web
   and VNC re-resolution (`packages/sandbox-docker/src/lifecycle.ts:478-497`).
   Register a Portless alias `<service>-<box>` per extra, mirroring `vnc-<box>`
   (`create.ts:1288-1296`) — host and in-box URLs must match
   (`feedback-symmetric-portless-urls`).
9. **Honest failures.** `BoxEndpoint` gains `label?` and `reason?`
   (`packages/core/src/endpoints.ts:8`). A service declared after create on
   docker/remote-docker, and a port beyond vercel's 4-port cap (silently dropped
   today at `packages/sandbox-vercel/src/backend.ts:85-96`), both surface as
   `reachable: false` with a reason a user can act on — reusing remote-docker's
   existing wording (`sandbox-remote-docker/src/backend.ts:627-637`).
10. **Names on cloud** (`packages/sandbox-cloud/src/cloud-provider.ts:1650-1659`):
    replace `service-<port>` with the real service name and label, read from the
    status snapshot the same way docker's builder does
    (`packages/sandbox-docker/src/endpoints.ts:59-66`).
11. OpenClaw's row declares `label: 'Dashboard'`
    (`packages/agent-registry/src/specs/openclaw.ts:148`).

### Phase C — surface it in every front-end

12. **Hub API**: `Box.endpoints: ApiBoxEndpoint[]` (`apps/hub/lib/boxes/types.ts:29-32`),
    populated in `mapBox` (`apps/hub/lib/hub-backend.ts:358-359`) where the two
    `.find()` calls are today. `webUrl`/`vncUrl` stay, derived from the primary — the
    tray decodes them by name and `agentbox list`/`url`/`screen` read them. Empty
    array for the Postgres source and registered boxes. Document in
    `apps/hub/app/(dashboard)/api/v1/lib/openapi.ts:1864-1873`; the coverage test
    checks paths only, so add a Box-schema assertion for the new field.
13. **Hub web UI** (`apps/hub/app/(dashboard)/boxes/components/access.tsx:176-195`):
    one button per reachable endpoint, labelled from the endpoint; unreachable ones
    render their `reason` in the existing `DisabledTip`.
14. **Tray** (`../agentbox-tray`): decode `endpoints` in
    `Sources/AgentBox/Models/Box.swift:24-25`; in
    `Sources/AgentBox/Menu/MenuBuilder.swift:196-205` the single "Open Web" becomes
    the primary's label plus one item per extra, with the `webUrl` path kept as the
    fallback for an older hub. Same in `BoxDetailWindow.swift:286-287,352-365`.
    Update the tray's own `CLAUDE.md` contract section.
15. **Docs, same change** — the "only one" rule is asserted in a dozen places:
    `agentbox-yaml.mdx` (§expose, `:211-230`), `web-apps-and-tunnels.mdx`
    (§Expose `:8-27` and the now-rewritable §Extra ports table `:104-129`),
    `services-and-tasks.mdx:144`, `openclaw.mdx:130`, `api.mdx:190`,
    `access-your-box.mdx:47`, `cli.mdx:131`, `integrations-herdr.mdx:112`, and the
    per-provider port claims in `daytona/e2b/vercel/tenki.mdx`. The provider table in
    `web-apps-and-tunnels.mdx` is currently *wrong* about vercel (docs say the base
    ports are `80/6080/8788`; the code declares `8080`) — fix it while there.

Each phase is written to be picked up by a cold session on its own. Running
findings go in the existing [`service-boxes-backlog.md`](./service-boxes-backlog.md);
Phase A closes blocker #1 of [`service-boxes-plan.md`](./service-boxes-plan.md).

## Verification

Unit work is necessary but proves little here — every one of these bugs is invisible
to a unit test. Start slow commands in the background and tail
`~/.agentbox/logs/latest.log` rather than choosing a timeout.

**Phase A — the bug that motivated this.** Only a real cloud box shows it:

```sh
agentbox openclaw --provider hetzner -y -n clawhz
agentbox shell clawhz -- sudo tail -5 /var/log/agentbox/web-proxy.log   # no EADDRINUSE
curl -fsS "$(agentbox openclaw url clawhz | head -1)/healthz"           # 200, not a 302
```

Ground truth is the `curl`, not the word "ready" — a box reaching ready proves only
that the gateway bound a loopback port (`project-cloud-box-usable-not-just-ready`).

**Phase B — two services, one box**, on docker (the reference) and on one
arbitrary-port cloud (e2b or hetzner):

```sh
# a workspace whose agentbox.yaml exposes an app (as: 80) and an admin UI
agentbox create -y -n multi
agentbox inspect multi        # two named endpoints with labels, both reachable
curl -fsS "$(...)/" ; curl -fsS "$(...admin...)/"
```

Then the negative cases, which are the point of the `reason` field: add a third
`expose:` to a **running** docker box and confirm it renders `reachable: false` with
the recreate message rather than a dead URL; and create a vercel box with two extra
exposes and confirm the one beyond the cap says so instead of vanishing.

**Phase C** — through the API, with the CLI not involved:

```sh
TOK=$(cat ~/.agentbox/hub/token)
curl -s localhost:8787/api/v1/boxes -H "Authorization: Bearer $TOK" | jq '.boxes[].endpoints'
```

then the hub UI's box page, and the tray menu showing **Open Dashboard** for an
OpenClaw box. The hub is a persistent daemon — rebuild the standalone bundle and
`hub restart` with `AGENTBOX_HUB_BIN` set, or you will verify stale code.
