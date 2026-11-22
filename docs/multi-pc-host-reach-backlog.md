# Multi-PC host-reach routing: leftovers

Open items after multi-PC Phase 4 (PR #426: host-reach goes to the box's origin
PC, then another online PC with the repo checked out, then the custody cache).
Each is acceptable for **one owner with several PCs**, which is what Stage 1 is;
each is a hole once a hub serves several **people** (Stage 2, teams), and has to
be closed before that ships.

## Stage 2 (teams) blockers

### Any enrolled device can answer any device's approvals

`adminBearer()` (`packages/relay/src/server.ts`) swaps a verified device token for
the admin token on the admin-gated routes, and `/api/v1/approvals/:id/answer`
accepts any authenticated caller. So device X can answer a confirm that device Y
mirrored into the hub (`POST /admin/prompts/answer`, or the API route), approving a
copy of Y's files. The host-reach routes themselves are device-scoped (a poller
id is bound to its device; a result, decline or prompt read/cancel must come from
that device), but answering is not. Fix with Stage 2's users: an approval is
answerable by the box's owner, not by any device.

### Any enrolled device can make itself a fallback server

`PUT /api/v1/checkouts` checks that a device token reports only its OWN machine id
(PR #426), but not that the repo key or folder are real: a device can report a
checkout of any repo. It then becomes a `has-repo` candidate for every box of that
repo, so while the origin PC is offline it can serve `cp fromHost` (inject files
into the box) and receive `cp toHost` (box output). The PC-side checks (the folder
must be a checkout of the repo; a `has-repo` PC serves only paths inside it) stop
an honest PC from leaking its own disk, not a hostile device from lying. Fix with
Stage 2: only devices of the box owner (or a project member) are candidates.

### The shared admin token may claim any device

A caller holding the hub's shared admin token can name any device in
`X-Agentbox-Device` and bind a poller as that device. That token is the hub's own
key (it reads custody and approves devices), so this is by design for one owner;
for teams PCs must never hold it (device tokens only).

## Remaining from review item 7 (double execution on re-offer)

- **Mostly pre-existing**: an owner PC partitioned for longer than
  `relay.hostReachTimeoutMs` while its confirm is pending has its action re-offered;
  if the next PC runs it and the first one later comes back and the user approves
  there too, both execute (the late result is rejected by `deliveredTo`, but the
  copy happened). Closing it needs the first PC to learn the action was taken back
  before executing (re-check with the hub after approval), which is a protocol
  change.
- **Fixed in #426**: the first PC's mirrored hub prompt is withdrawn when the action
  is re-offered (`onReoffer`), and the PC-side mirror only forwards the action's own
  confirm (matched by its command), not another prompt the same box raises
  meanwhile.

## Other

- `docker:hub` boxes show as `remote-docker (inactive)` on PCs and are unreachable
  from a second PC (the control box's ssh is locked to the operator's IP).
- `download.*` is not a host-reach method, so it is not routed (it still needs the
  machine that created the box).
- Multi-repo boxes: `hostCandidatesFor` already picks a nested repo by path prefix,
  but registrations describe one root repo until box-sources Phase 2.

## From the review of #429 (agentless box started OpenClaw), noted, not fixed

- **`route.box.agent` is for future routed methods.** Host-reach routes only `cp.*`,
  `tool.*` (and, with #432, `download.workspace`); none of them asks `agents.list`,
  so passing the box's agent on a routed action changes nothing today. Kept so a
  future routed method that does reach `agents.list` answers for the right agent.
- **Tests do not drive the real start/resume paths.** The decision-path test calls
  `primaryAgent` + `registrationAgents` directly; the server's register/replace
  path, `cloud-provider` start/resume and the hub worker's create record are
  covered by the unit tests of their pieces, not end to end.
- **Provider SDK republish.** `createCloudProvider` is inlined into
  `@madarco/agentbox-provider-sdk`: plugin providers get the control-plane resume
  fix (`primaryAgent`) only after the SDK is rebuilt and republished (no
  `SDK_API_VERSION` bump: not an API break). The owner publishes.
- **A box running a TUI agent AND a service agent** (`['claude', 'openclaw']`):
  a registration carries one agent, `primaryAgent` returns the first, so the
  service agent gets no units. Not a regression (a claude box registered `claude`
  before #429 too). Fix: carry the full list on the registration (`agents: string[]`).
