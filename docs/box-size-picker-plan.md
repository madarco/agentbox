# Pick a box size at create time — plan

Status: **done** (all four phases). Kept as the record of WHY the shape is this one.

## Why

A box's VM size is reachable only from the CLI (`--size`, or the `box.size<P>`
config key), and the legal values live only as prose inside each provider's
`sizeDesc`. There is no way to start a bigger box from the web hub or the tray —
the concrete blocker being a desktop box with enough RAM for something like
Godot (8 GB+), which no default provides.

`--size` has **no common grammar**; each backend parses it natively:

| provider | grammar | 8 GB | applies at |
|---|---|---|---|
| docker | *ignored* (`box.memory` / `box.cpus`) | — | — |
| hetzner | server-type slug | `cx33` (4·8), `cx43` (8·16) | create |
| digitalocean | droplet slug | `s-4vcpu-8gb` | create |
| vercel | vCPU count, RAM coupled 2 GB/vCPU | `4` | create |
| remote-docker | `cpu-mem` GB | `4-8` | create |
| daytona | `cpu-mem-disk` GB | `4-8-10` | **bake** |
| e2b | `cpu-mem` GB | `4-8` | **bake** |

That variation is what a UI needs told declaratively, and `ProviderDescriptor`
already had the field for it (`sizes`), served all the way to both clients by
`listProviders` -> `GET /api/v1/providers` -> `ProviderOption`, and populated by
nobody. The rail existed end to end and was empty.

## Out of scope, deliberately

To be done later as one piece: the generic per-provider config namespace
(`box.*` -> provider-specific blocks, the way agents got `claude.install`), a
settings-page control that persists a default size, and the other per-provider
knobs (regions, timeouts, network policy, daytona's sandbox class). Nothing here
blocks that or has to be undone by it — this adds descriptor data and two create
forms, and touches no config key.

## Design

### Descriptor

`packages/config/src/providers.ts`. `sizes` gains labels with real numbers, plus
two siblings:

- `sizeHint` — grammar hint for a free-text size. **Its presence is what says
  the list is OPEN**: a UI offers a custom-value escape only when there is a
  hint to place in it. One field doing two jobs, so there is no separate boolean
  to keep in sync. Vercel omits it because `parseVercelVcpus` throws on anything
  outside `sizes`.
- `sizeAppliesAt: 'create' | 'bake'` — `'bake'` means the size is fixed when the
  base is baked and rejected per-create (daytona's snapshot path, e2b
  templates), so a different size needs `prepare --force --size` first.
  `ProviderModule.sizeIgnoredReason` answers whether a *given* size actually
  needs that re-bake.

Docker declares none: its knobs are `box.memory` / `box.cpus` / `box.disk`, and
an inert dropdown is worse than no dropdown.

Plugins get all of this for free — `ProviderDescriptor` is already re-exported
by the SDK and `agentbox plugin add` already snapshots the whole descriptor into
`~/.agentbox/plugins.json`. Additive to an optional field, so `SDK_API_VERSION`
stays **4**.

### Hub API

`sizes` already flows through `listProviders` untouched; `sizeHint` and
`sizeAppliesAt` join the same pass-through and `ProviderOption`.

One new route, `POST /api/v1/providers/:id/size-check`, body `{ size }` ->
`{ rebakeRequired, reason? }`, calling the existing `sizeIgnoredReason` hook.
This is what stops the UI firing a pointless 2-10 minute bake when the requested
size is already the baked one, and it returns the exact sentence the CLI prints.

Nothing else is needed: `opts.size` on `POST /api/v1/boxes` and `size` on
`POST /api/v1/providers/:id/prepare` already exist and are already honored.

### Clients

Web (`create-box-modal.tsx`): a Size field in the existing `showAdvanced`
disclosure — a select over `sizes` plus a `Custom…` option gated on `sizeHint`,
hidden when the provider declares no `sizes`. On a `bake`-scoped provider a
changed size runs `size-check` and, if required, routes through the existing
two-phase bake-then-create with `{ size, force: true }`. **`force` is
load-bearing**: a size change does not move the build-context fingerprint, so
without it the bake is a fast no-op and the size never lands.

Tray (`CreateBoxPanel.swift`): a Size `NSPopUpButton` under the provider popup,
same rules, driven entirely by `option.sizes` — no switch on provider id.

## Phases

| # | Phase | Status |
|---|---|---|
| 1 | Descriptor fields + built-in size tables + SDK bump/docs + drift test | done |
| 2 | Hub API: field pass-through, `POST /providers/:id/size-check`, openapi | open |
| 3 | Web create modal: Size field, custom entry, bake-scoped re-bake | open |
| 4 | Tray create panel + client methods; public docs + CHANGELOG | open |

### Phase 1 — what landed

- `ProviderDescriptor.sizeHint` / `.sizeAppliesAt`; `sizes` populated for the
  six non-docker built-ins (values read off each backend's own parser/default,
  not invented).
- `parseDaytonaSize` / `parseE2bSize` / `parseVercelVcpus` exported from their
  package barrels, purely so the declared keys can be asserted against the
  parsers that must accept them.
- `apps/cli/test/provider-sizes.test.ts` — the guard. Notably it pins
  `sizeAppliesAt: 'bake'` to exactly the providers implementing
  `sizeIgnoredReason`: the two are the same fact, and a provider growing one
  without the other gives a UI either a dead control or a needless bake.
- SDK 4.0.0 -> 4.1.0 (**needs a republish**), `docs/provider-plugins.md` ->
  "Declaring sizes", and the example provider declares a picker as the E2E
  fixture.

## Verification

1. `pnpm test` + `pnpm typecheck` (tsup does not typecheck; CI runs tsc).
2. Hub is a persistent daemon serving the standalone bundle — rebuild and
   restart or you test stale code:
   ```
   pnpm --filter @agentbox/hub build:standalone
   AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart
   curl -s -H "Authorization: Bearer $(cat ~/.agentbox/hub/token)" \
     'http://127.0.0.1:8787/api/v1/providers' | jq '.data.providers[] | {id, sizes, sizeHint, sizeAppliesAt}'
   ```
3. A real box is the only proof the size is honored. Background it and watch the
   log rather than blocking:
   `node apps/cli/dist/index.js create -y -n size-smoke --provider hetzner &`
   then `tail -f ~/.agentbox/logs/create.log` until `box … ready`, and confirm
   with `curl -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers | jq '.servers[].server_type.name'`.
4. Bake-scoped path: pick a daytona size different from the baked one and
   confirm the prepare job carries `force: true` — without it the bake no-ops
   and the size silently does not land.
5. Plugin: declare `sizes` in `examples/agentbox-provider-example`, `npm pack`
   -> install -> `agentbox plugin add`, confirm the snapshot carries them; then
   a plugin with **no** `sizes` must be unchanged.
