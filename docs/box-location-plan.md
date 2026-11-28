# Box location and size, end to end

Status: accepted (owner-approved). Phases 1-3 implemented (one PR each, stacked).

A box's **location** (Hetzner datacenter, DigitalOcean region, Daytona region) and **size**
(Hetzner server type, DigitalOcean size slug, Daytona `cpu-mem-disk`, Vercel vCPUs) are already
choosable from `agentbox create --size/--location`, but only there. The control box itself
(`hub setup`, `hub deploy`) cannot pick either on Hetzner, no client shows where a box landed, and
the web create dialog offers size only. This plan carries both values through every surface.

Live edge cases found along the way go in [`box-location-backlog.md`](./box-location-backlog.md).

## Design rules

- **Opaque per-provider strings.** A location is whatever that provider's API calls it (`hel1`,
  `fra1`, `eu`); a size likewise (`cx33`, `s-4vcpu-8gb`, `4-8-10`). There is no cross-provider
  grammar and no mapping table, so a future AWS provider declares `eu-west-1` / `m7i.large` without
  touching anything shared.
- **The descriptor declares the choices.** `ProviderDescriptor.regions` (`[{key,label}]`, most
  common first, first entry = the provider default) plus an optional `regionHint`, exactly like
  `sizes` / `sizeHint`: the hint's PRESENCE says the list is open and a UI may offer a custom value.
  Absent `regions` = the provider has no location knob (docker, vercel, e2b, remote-docker).
- **The live catalog answers compatibility.** Not every size exists in every location (Hetzner's
  `cx` line is eu-central only; DigitalOcean sizes list their regions). The static descriptor does
  not try to encode that; `POST /api/v1/providers/{id}/size-check` grows a `location` input and
  answers from the provider's live catalog when it has one.
- **Everything through `/api/v1`.** The CLI, web and tray are clients of the hub (CLAUDE.md →
  Conventions). `hub setup` / `hub deploy` are the exception only because they create the hub.

## Phase 1: hub setup + deploy, descriptor regions

Touches:
- `packages/config/src/providers.ts`: add `regionHint` to `ProviderDescriptor`; fill `regions` for
  hetzner (`nbg1`, `fsn1`, `hel1`, `ash`, `hil`, `sin`), digitalocean (its common regions, `nyc3`
  first) and daytona (`us`, `eu`; the label notes linux-vm runs in `us-east-1` only). Vercel, E2B:
  none.
- Hub `/api/v1/providers`: pass `regionHint` through (`hub-backend.ts`, `boxes/types.ts`,
  `openapi.ts`).
- `apps/cli/src/commands/control-plane.ts`:
  - `hub deploy hetzner --location <dc> --size <server type>` (the package deploy already accepts
    `serverType` / `location`, defaults `cx23` / `nbg1`).
  - `hub deploy digitalocean --location/--size`; `--region` stays as a hidden alias.
  - `hub setup --location/--size`: after picking hetzner or digitalocean, a clack `select` for each
    from the descriptor lists, the defaults preselected, plus "Custom..." where a hint exists.
    A flag skips its prompt; `-y` takes the defaults. A size below the hub floor (`cx23` /
    `s-2vcpu-4gb`: the VPS runs the hub and docker) warns.
  - The deploy record (`deploy.json`) carries `location` / `size` (nothing reads them yet).
- Provider SDK docs (`docs/provider-plugins.md`, `apps/web/content/docs/build-a-provider.mdx`):
  document `regions` / `regionHint`.
- Public docs: `deployed-hub.mdx`, `hetzner.mdx`, `digitalocean.mdx`, `cli.mdx`.

## Phase 2: record and show

Touches:
- Record the real location for every provider that has one. Hetzner already records the landed
  location after failover. DigitalOcean: read `droplet.region.slug` from the create/get response
  into the handle. Daytona: the resolved region (explicit `box.daytonaRegion`, else the derived
  `us-east-1` for linux-vm, else whatever the sandbox reports as its `target`).
- `GET /api/v1/boxes`: the Box gains optional `size` and `location` (openapi schema, `Box` type,
  `mapBox`). `agentbox ls --json` carries them.
- `agentbox status <box>` prints `size` and `location` lines for cloud boxes.
- Docs for the new fields (api.mdx, cli.mdx).

## Phase 3: pick at create

Touches:
- Web create dialog (`create-box-modal.tsx`), Advanced: a Location select when the provider
  declares `regions`, default "Automatic" (the provider's configured/default location, failover
  allowed); a chosen location sends `opts.location` + `opts.locationPinned: true`; a custom value
  where `regionHint` exists.
- `POST /providers/{id}/size-check` takes `{size?, location?, agent?, projectId?}`. With a location
  it calls the new optional `ProviderModule.checkPlacement`, which runs the create's own preflight
  against the live catalog (hetzner `validateServerChoice`, DigitalOcean `validateSizeChoice`,
  Daytona snapshot `regionIds`). An empty size is checked as the default the create would use
  (the project's config, else the provider's). The dialog shows the answer.
- Verify the hub create path (`validate.ts` → `hub-worker.ts` → `cloudSizingProviderOptions`)
  records and honours a pinned location on hetzner and digitalocean.
- Tray contract in the PR body (the tray lives in `../agentbox-tray`).

## Open questions

1. **Daytona region vs. the baked snapshot.** A snapshot lists the regions it exists in
   (`regionIds`, measured `["us"]` for this account's base). Phase 1 has the backend refuse an
   explicit region outside that list with a pointer. Phase 3 shows the Daytona regions and the
   placement check warns in the dialog when the base is not in the chosen region.
2. **DigitalOcean snapshots are regional.** The create preflight already refuses a region the
   snapshot is not in. Phase 3's placement check runs that same preflight, so the dialog says so
   before the create.
3. **Floor for the control box.** `cx23` / `s-2vcpu-4gb` are the documented floor. Should setup
   refuse a smaller size or only warn? This plan warns (a user may know their load).
4. **Hetzner failover for the control box.** Box creates fail over within a network zone; the
   control-box deploy does not. Out of scope here (backlog).
