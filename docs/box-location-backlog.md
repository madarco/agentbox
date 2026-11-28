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
