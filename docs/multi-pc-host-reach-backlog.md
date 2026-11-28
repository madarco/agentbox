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

### Any enrolled device can sign an account in or out

The account write routes (`POST/DELETE /api/v1/accounts…`, `…/renew`, and the
hub sign-in `…/{agent}/{id}/login` + `…/login/code`) take any authenticated
caller, with no device or owner gate: a device can renew, replace or remove the
hub's subscriptions. Fix with Stage 2's users: only the owner manages accounts.

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
- `download.*` is routed to the box's origin PC only (no fallback, no cache): it
  writes the box into the project it was created from, so another PC's clone would
  be overwritten. `env`/`config`/`claude` kinds are still unsupported for cloud
  boxes, as before.
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
- **A box running a TUI agent AND a service agent loses the service agent's units on
  its next start.** `agentbox openclaw <a claude box>` makes the hub set
  `reg.agent = 'openclaw'` (the gateway comes up), and the record becomes
  `agents: ['claude', 'openclaw']`. But every later re-registration (start, resume,
  rehydrate) sends `primaryAgent(record)`, which is `'claude'`, so after the first
  restart `agents.list` ships no openclaw units and the gateway is gone. A registration
  carries one agent. Fix: carry the full list on the registration (`agents: string[]`),
  or have `primaryAgent` prefer a service agent. Not a regression: a claude box
  registered `claude` before #429 too.

## From the review of #432 (origin-only download)

- **Fixed in #432 (owner decision): a download never unpacks a `.git`.** The workspace
  download (`pullCloudDirContents`, the cloud executor behind `agentbox-ctl download`
  on every hub, local included) used to unpack the box's whole `/workspace`, `.git`
  included, over the project: the PC's git config, HEAD, index and refs replaced (a
  hub box's clone is shallow), hooks plantable, and it auto-approves as a contained
  download. `.git` (any depth) is now excluded when the box packs AND when the PC
  unpacks. Box commits reach the PC through git (push, `--host-only`), never a copy.
  Still open: it overwrites tracked files with local uncommitted changes, with no
  backup (the CLI's `agentbox download` has preview + backups; the cloud executor
  does not).
- **Folder guard can be skipped on the origin with a stale record.** When the origin's
  own record points at a moved folder (`recordOk` false) and the registration has no
  `originFolder`, `hostFolder` is never set, so the host-reach-only "folder must exist"
  guard does not run and the download lands in a recreated empty folder (on the origin,
  nothing overwritten). Fix: key the guard on an explicit host-reach flag from
  `executeHostReachAction`, not on `hostFolder`.
- **No PC-side defense for a download routed as `has-repo`.** The hub never routes one
  that way (origin only), but `executeHostReachAction` only confines `cp.*` for
  `has-repo`. Fix: decline `download.*` unless the route says `origin` and
  `route.box.originMachineId` is this machine.
- **`hub expose` (the hub is the user's PC): a download for a hub-built box from that
  same machine says "not connected".** No host-reach poller runs on a control box, and
  there is no "the origin is this machine, run it locally" shortcut (failed before the
  PR too, ENOENT; `cp` has the same gap). Fix: when `originMachineId` is the hub's own
  id, execute locally against `originFolder`.
- **The no-origin refusal names a placeholder** (`agentbox download <box>`), because
  `hostReachRouteFor` has no box name. Fix: pass `reg.name`, or build the message in
  `server.ts` where `reg.name` is in scope.
## docker:hub boxes on other computers (follow-up fix 3), noted, not fixed

- **Direct attach / shell / `cp` from a computer that did not deploy the control box
  (owner decided, 2026-11-22).** They need SSH to the control box's engine, which today
  is `ssh root@<control box>` with the deploy key, firewalled to the deploying computer:
  root on the hub.
  - **Now: D (shipped in #436).** Those commands stop with a message naming the reason;
    hub-side actions (start/stop, git, web UI, tray) work from every computer.
  - **Follow-up: A, terminals over WebSocket served by the hub.** Attach and shell for
    every box, any provider, from any enrolled computer, through the hub: a
    device-token-authenticated WebSocket PTY, with the hub opening the session on the
    box itself (`docker exec` for its own engine). No new SSH access for any computer.
    Not started.
  - **Rejected: B**, a restricted per-device SSH key on the control box with a
    forced-command `docker exec`. The docker group is root-equivalent, so any hole in
    the forced command is root on the hub.
  - **Not needed: C**, an sshd inside each box container. A covers the same need
    without a published port and a firewall rule per box and per device.
- **A pre-existing `hub` alias that is not the control box.** `ensureHubDockerTarget`
  leaves a user's own `hub` alias alone (`hub -> me@nas`), so on the deploying computer
  direct actions on a docker:hub box dial that host instead and fail with "no such
  container". Pre-existing; fix: register the control box's engine under a reserved
  name, or have setup refuse/rename when `hub` is taken.

## From the review of #436 (docker:hub on other computers), noted, not fixed

- **The unregistered-alias hint replaces the ssh advice for the user's own single-word
  hosts.** A pre-registry box id that baked a `~/.ssh/config` Host (`nas`), or a PC's
  own `Host hub`, gets "registered on another computer" (or the control-box text) when
  that dial fails for its own reasons, and loses the "Check that `ssh <spec> true`
  works" line (the raw ssh stderr is still appended). Fix: keep the original line and
  append the hint as a conditional, or add it only for boxes from a remote hub listing.
- **The hint can surface inside the hub.** The hub is itself a remote-docker client:
  after `remote-docker unshare <alias>`, or when deploy only warned in
  `ensureSelfDockerHost` (no `hub` on the control box), a hub-side action fails with
  "use the hub web UI or the tray". Fix: wording that fits any caller, or a CLI-only
  flag to enable the hint.
- **A stale cache is assumed to come from the control box.** If `hub-boxes-cache.json`
  was last written by the local hub (just before a control box was configured) and the
  control box is unreachable, local remote-docker leftovers show live instead of
  inactive. Cosmetic, stale path only. Fix: record the source mode in the cache (no
  secrets, so the token-free rule holds).
- **Plain docker in a remote listing is always tagged inactive, even when the control
  box IS this machine** (`hub expose` with `relay.controlPlaneUrl` set): this Mac's real
  docker boxes show "(inactive)", and so does a PC pointed at it. Pre-existing (nightly
  never consulted `controlBoxIsThisMachine`); #436 only makes the always-mute explicit.
  Fix: skip the mute when `controlBoxIsThisMachine()`, the same exception
  `dockerProviderRefusal` makes.

## Fixed

- **The API key alone could enroll a device (fixed 2026-11-23, `fix/hub-elevated-auth`).**
  From #422, `canApproveDevices` accepted the shared API key, which the tray, the web
  and every thin client hold. With it a caller could start a code
  (`/devices/code`), approve it (`/devices/approve`) and claim a device token
  (`/devices/token`), and a device token passes the elevated custody byte read, so
  the API key alone could read stored values. Approve, deny, the pending list's
  deny-all and revoking or renaming another device now need a signed-in session,
  or the API key plus the admin token (`X-Agentbox-Admin-Token`, timing-safe, refused
  when the hub has none). `agentbox hub devices approve|revoke|rename` send the
  admin token when the machine has it and otherwise point at the web Devices page.
  A device revoking or renaming itself is unchanged.

- **The operator PC loses `hub devices approve` once it enrolls (fixed 2026-11-28,
  `fix/setup-enrolls-operator`).** From #422: its device token shadowed the API key in
  `resolveHubTarget`, and `loadControlPlaneEnv` had put the device token into
  `AGENTBOX_RELAY_ADMIN_TOKEN` too, so approve answered 403 ("only the hub owner").
  `hub devices approve|revoke|rename` now read the API key and admin token from
  `control-plane.env` (`ownerCredentialsFor`) and send both, only to the hub the
  deploy record names (or one on this machine).
- **The operator PC was never a device (fixed 2026-11-28, same branch).** `hub setup`
  / `hub deploy` / `hub update` left the deploying machine on the shared keys, so
  `GET /api/v1/skill-machines` was empty and the Skills page could not compare with
  it. `finalizeControlBoxState` now enrolls it (`enrollOperatorDevice`), approving
  the code with its own API key + admin token; skipped for `hub expose`, a no-op
  when already enrolled, a revoked machine stays revoked, and skipped when
  `relay.controlPlaneUrl` names another URL (the token is matched against it). A failed
  approve withdraws its code. No local hub restart: the running relay's poller already
  names this machine in `X-Agentbox-Device`.

- **The tray could not compare skills once its machine enrolled (fixed 2026-11-28, same
  branch).** `/api/v1/skill-machines/{id}/compare` took only a session or
  `X-Agentbox-Admin-Token`, and the tray sends just its Bearer (`hub target --json`), which
  on an enrolled PC is the device token, so its skills row stayed "Not compared". A device
  token may now compare its own machine (`skillMachineCompareAuthorized`: the token's
  device == `{id}`); another machine, and pull/send, stay owner-only. Still open: a tray
  on a PC that never enrolled sends the plain API key, which compare still refuses (its
  row stays "Not compared"); `hub setup` now enrolls the operator PC, and other PCs
  enroll with `hub login`, so this is only a never-enrolled PC.

## From the real-Hetzner sign-off of #429 / #432, noted, not fixed

- **`hub login` blip.** A PC's first `hub login` ended in `fetch failed`; it did not
  reproduce on retry.
- **Poller noise for hub-built boxes.** The hub logs `[cloud-poller <id>] poll error:
  bridge/poll -> 404` every 30 s for every control-plane-topology box.
- **A download whose origin is offline waits the full 60 s** before failing, even when
  the origin has never connected; it could answer at once.
- **The no-origin download message prints a literal `<box>`** (also noted under the
  #432 review).
- **`agentbox-ctl status | head -4` crashes with an EPIPE stack trace.**
- **`tool.list` for a box with no origin runs on any PC.** Known from #426.
- **A box cut off by the old PC-local re-register stays cut off.** Before #429's fix, a
  re-register from the operator PC wrote its record's token into the hub's
  registration; the box's relay.env keeps the hub's original token, so every box->hub
  call 401s and a hub stop + start does not heal it. Recreate such a box. Root cause
  (PC records can carry a different `relayToken` than the hub's) predates #429: any
  remaining PC-local `registerBoxWithPlane` path can do the same.

- **Host off: a classic cloud box's `agents.list` retries pile up.** With the PC asleep
  (or an independent box), each retry parks another `agents.list` on the in-box queue
  (13 in all, about 11 minutes with the 30 s timeouts) and holds an in-box socket. On
  reconnect the poller drains and answers all of them (read-only, unprompted). An
  unregistered hub-built box logs 13 "relay returned 401" lines over about 5 minutes.
  Minor; fix: drop a parked `agents.list` when a newer one from the same box is queued.
