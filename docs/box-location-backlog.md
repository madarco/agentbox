# Box location and size: backlog

Edge cases found while doing [`box-location-plan.md`](./box-location-plan.md) and deliberately not
fixed there. Newest last.

- **Control-box deploy has no capacity failover (hetzner).** `deployControlPlaneToHetzner` creates
  once in the chosen location; a `412 resource_unavailable` in nbg1 (common for cx23) fails the whole
  deploy, while box creates retry the other eu-central locations (`failover.ts`). The deploy could
  reuse `planLocations` when the location came from the default rather than `--location`.
  (`packages/sandbox-hetzner/src/control-plane-deploy.ts` ~770)
- **The Hetzner size/location table is static.** The descriptor's `regions[].sizes` (per-location
  lists and defaults) and `sandbox-hetzner/src/placement-rules.ts` (which line is offered where,
  the control-box floor; measured 2026-11-28) can drift from the live catalog. Asking
  `GET /server_types` at setup time (the token is local) would make the control-box warnings live.
- **Daytona `--location` away from the baked region.** Declaring Daytona `regions` makes a typed
  `--location` reach the backend (it already honoured `box.daytonaRegion`). The base snapshot is
  registered in the region it was baked in (`PrepareRequest.location`, `packages/core/src/provider.ts`
  ~486). Measured 2026-11-28: this account's container base `agentbox-base-8bd5e8c8e330-*` reports
  `regionIds: ["us"]` from a default, `us` and `eu` client alike, so a box asked for in `eu` boots
  against a snapshot that is not in that region (create not tried: whether Daytona replicates or
  refuses is still open). Phase 1 makes the backend refuse up front with a pointer when an explicit
  region is not in the snapshot's `regionIds` (or is not us-east-1 for a linux-vm base). Still open:
  one prepared base per provider, so baking in a second region replaces the first.
- **Size is recorded only when one was asked for.** `cloud.size` is written from `--size` /
  `box.size<P>`; a box made with the provider default records none, so `status` says
  "(provider default)" and the Box payload omits `size`. Backends that report `resources` (hetzner,
  DigitalOcean) could also return the effective size slug in the handle.
  (`packages/sandbox-cloud/src/cloud-provider.ts` ~1631)
- **Registered boxes carry no size or location.** A box known to a hub only through its
  registration (`mapRegistrationToBox`, `apps/hub/lib/hub-backend.ts` ~639) has neither field: the
  registration wire (`BoxRegistration`, `packages/relay/src/types.ts`) does not carry them.
- **Daytona `target` vocabulary is unmeasured.** Phase 2 records a Daytona box's
  `cloud.landedLocation` from the sandbox's `target` (the SDK documents it as the runner's target
  location). No sandbox existed to compare it with the `us` / `eu` / `us-east-1` region names. It is
  display-only (clones replay `location`, never `landedLocation`), so a mismatch shows an odd label
  and changes nothing else.
- **The CLI shows size/location only from a local record.** `agentbox status` renders the local
  `BoxRecord`; a box that lives only on a remote hub shows them through `ls --json` / the Box
  payload, not `status`.
- **Tray: per-region sizes.** The tray has the Location row, the pinned create payload, the
  size-check advisory and the details rows (agentbox-tray f090f38). It does not yet read
  `regions[].sizes`: when the picked region lists sizes, the Size list should show those
  instead of `sizes` (first = that region's default; label the empty choice "Default here
  (<key>)") and reset a picked size the new list lacks.
- **`agentbox prepare --provider hetzner` still bakes on cx23.** `prepare.ts` hardcodes cx23 for
  the temporary bake server, so a global `box.hetznerLocation: ash` (or hil/sin) with no size
  fails the bake. It should use `defaultServerTypeFor(location)` from `@agentbox/sandbox-hetzner`.
- **Hetzner details in CLI help text.** `control-plane.ts` (`hub deploy` help), `cloud-sizing.ts`
  and `prepare.ts` still list Hetzner locations and the cpx defaults as literal text; build them
  from the descriptor.
- **The dialog's "Default here" label ignores a configured size.** With a project
  `box.sizeHetzner: cx33`, the label still names the region default; the create uses cx33 (the
  size-check does warn).
