# Persistent boxes & service agents — backlog

Minor / deferred items found while implementing `service-boxes-plan.md`. Each phase appends
here rather than sidequesting. Promote an item to the plan if it turns out to be load-bearing.

## From Phase 0 (openclaw PoC, 2026-09-02)

- **`--allow-scripts=openclaw` leaves four dependency install scripts unrun** — `koffi` (native
  FFI), `tree-sitter-bash` (node-gyp-build), `protobufjs`, `@google/genai`. openclaw installs and
  serves anyway, but a feature routed through those deps may be silently degraded. Decide whether
  to broaden the allowlist once a real channel is exercised.
- **openclaw is 893 MB installed.** If we ever want a baked variant, measure the pull cost first;
  on-demand install is the default for good reason.
- **Channel pairing is unverified.** `openclaw channels add --use-env` and *which* dirs a pairing
  needs to survive a restart both need a real credential. Do it when a channel is first wired.
- **`~/.config/openclaw` is empty after onboard.** It is persisted on the assumption it holds the
  auth-profile encryption key; confirm when auth profiles are actually used.

## From Phase 7 (deferred, needs real money / shared state)

- Re-run the base bake for the VPS providers now that the openclaw row has landed. Not run from
  inside a box: it costs real money and mutates shared prepared state.

  ```sh
  node apps/cli/dist/index.js prepare --provider hetzner
  node apps/cli/dist/index.js prepare --provider digitalocean
  ```

  Watch for the `box.image` cross-provider collision (`agentbox config unset box.image --project`
  to recover). Note the bake is **not required for openclaw**: nothing openclaw needs was added to
  either provider's `install-box.sh` or runtime-asset list — the binary comes from the catalog on
  demand and the units ride `agents.list`. The re-bake is only to pick up whatever else has moved
  in the base since the last one.
- **Live-verify openclaw on the VPS providers** once the above has run: `CLAW-001`, `CLAW-002` and
  `CLAW-006` from [`../test-plan.md`](../test-plan.md) against `--provider hetzner`,
  `--provider digitalocean` and `--provider remote-docker`. Phase 6/7 smoke-tested docker only.
  remote-docker is the one to watch: docker-shaped image and checkpoints, cloud-shaped workspace
  sync, so it is the main consumer of Phase 4's non-git sync leg.

## From Phase 1 (persistent boxes, 2026-09-02)

- ~~**`--persistent` is not on the agent commands yet.**~~ **Done (2026-09-03.)** Declared once in
  the shared agent-flag table (`apps/cli/src/agents/command/options.ts`) and forwarded from
  `create-action.ts` down all four create paths (docker, cloud, the hub adopt, the `-i` queue job),
  with the e2b/vercel refusal running before routing as it does on `create`.
- **`../agentbox-tray/CLAUDE.md` not updated.** The plan calls for it (the `GET /api/v1/boxes`
  payload is the tray's contract) but the sibling checkout is not present in this box. The new
  `persistent` field is documented in `apps/web/content/docs/api.mdx`; mirror it into the tray's
  doc from the host.
- **The hub's `destroy` route has no persistent guard.** `agentbox destroy <box> -y` refuses on a
  persistent box, but `POST /api/v1/boxes/{id}/destroy` (the web UI, the tray) tears one down with
  only the client's own confirm. Decide whether the guard belongs behind the API — where every
  front-end inherits it — or stays a client concern.
- **The boot reconcile needs a running relay.** A persistent box comes back when the relay
  daemon starts, so a host where the relay is not installed as a login/launchd unit gets no
  restart. `agentbox hub expose` installs such a unit; a plain dev host may not have one.
- **The hub's create form repeats the capped-provider list.** `create-box-modal.tsx` carries its own
  `PERSISTENT_CAPPED = {e2b, vercel}` to grey the checkbox out, because the client bundle
  deliberately imports no `@agentbox/*` package. The API still refuses the create, so the copy is a
  UX affordance rather than the gate — but it is a second place to edit if a provider ever grows or
  loses a session cap. Serving it from `GET /api/v1/providers` would remove the copy.
- **`selectPersistentBoxesToStart` skips `missing`.** A persistent cloud box whose sandbox the
  provider reaped (rather than stopped) is logged once and left alone — recreating it from the
  record is a Phase 4/5 question (workspace sync), not a reconcile one.
## From Phases 2-3 (service-agent surface + layered config, 2026-09-02)

- **`agentbox <agent> stop` bypasses the hub.** The hub's services routes expose `restart` but not
  `stop`, so `service-factory.ts` reaches the box's ctl through `provider.exec`. Every other box
  operation goes behind `/api/v1`; add a stop route and drop the direct exec.
- **The `AGENT` column shows `unknown` for a service agent.** Phase 2 called for `agentbox list`
  and the hub payload to read the ctl SERVICE state for a `surface: 'service'` agent instead of
  probing a tmux session that will never exist. Left out here because it lands in
  `apps/cli/src/commands/list.ts` and the hub box payload, both outside this change's blast radius.
  Do it with (or before) Phase 6, when there is a real service agent to see it on.
- **The JSON schema squiggles an agent's overlay key.** `agentbox.schema.json` stays
  `additionalProperties: false` on purpose — it drives editor autocomplete, where flagging
  `defualts:` as you type is worth more than a clean overlay block — so a service agent's
  `overlayKey` shows as an unknown top-level key in an editor while the supervisor accepts it. If
  that becomes annoying, the fix is a generated per-project schema, not a wildcard.
- **`agent render` re-asserts the whole overlay when the record is lost.** Dropping
  `~/.<agent>/.agentbox-overlay.json` (a checkpoint that misses it, a wiped config volume) makes the
  next render send every key, overwriting in-box hand edits to keys the overlay names. That is the
  safe direction, but it is worth surfacing in the output rather than doing quietly.
- **The overlay is resolved once, at render time.** A `{{AGENTBOX_*}}` placeholder is baked into the
  overlay record, so a box renamed after a render sees the old value until the overlay itself
  changes. Fine today (the placeholders are box identity, set at create); revisit if a placeholder
  ever becomes mutable.
## From Phases 4-5 (workspace sync + clone, 2026-09-02)

- **The NUL-termination bug was live in BOTH resync implementations.** `probeUntrackedTokens` fed
  the box `paths.join('\0')` in `packages/sandbox-cloud/src/sync/workspace-resync.ts` *and* in
  `packages/sandbox-docker/src/sync/in-box-git.ts`, but `read -r -d ''` treats an unterminated tail
  as EOF — so the LAST untracked path was never probed, came back as "absent in the box", and was
  overwritten by the host's version on every session-start resync. Reproduced live on docker
  (`agentbox upload` silently clobbered the box's `shared.txt`) and fixed in both; pinned by
  `packages/sandbox-core/test/box-files.test.ts` and
  `packages/sandbox-docker/test/resync-probe-nul.test.ts`. Worth a look for other `join('\0')`
  payloads.
- **Every box-side path list is now chunked; watch for new ones.** A list encoded into a single
  `printf` argument is capped by Linux `MAX_ARG_STRLEN` (128 KiB), which a normal repo exceeds — a
  9001-file workspace produced a 456 KB argument and `docker exec` refused it with
  `Argument list too long`. `chunkPathsForExec` (`packages/sandbox-core/src/sync/concerns/box-files.ts`)
  is the shared budget; `pullTar` creates with `tar -cf` and appends the rest with `-rf`. Any new
  box-side payload built the same way needs the same treatment.
- **Empty directories are not carried in exclude-list mode.** The selection is a file list
  (`find … -type f -o -type l`), and `rsync --files-from` only creates the parent dirs it needs. A
  workspace that depends on an empty `uploads/` existing gets it back only once it has a file. Fix
  by emitting `-type d -empty` entries if a real workload hits it.
- **`clone` of a git-backed box drops `.git`.** By design — the clone is a template, and a
  git-backed second box on the same project is a plain `agentbox create`. If a "second checkout with
  the box's uncommitted work" is ever wanted, it is a different feature: create normally, then
  overlay the export.
- **`clone` creates the new box with no agent (`agent: 'none'`).** Carrying the source box's agent
  id would mount that agent's SHARED config volume and credential, which is precisely what the
  fresh-identity contract forbids; giving the clone its own isolated volume needs an isolate override
  on the hub create input, which is create-path plumbing this phase does not own. Harmless for the
  plan's consumers — openclaw/t3code/hermes are ctl services declared in the `agentbox.yaml` that
  travels with the workspace — but a `clone` of a `claude` box today yields an agentless box. Fix
  alongside Phase 2, when `caps.surface === 'service'` already derives `isolate`.
- **`sync` has no `--dry-run`.** `download` does, and the machinery (hash + probe + classify) already
  computes the full plan before writing anything, so it is a flag and a return path away.
- **`agentbox upload` runs inline in the CLI, not through the hub.** The hub route exists
  (`POST /api/v1/boxes/:id/sync`) and the web UI/tray can use it, but the CLI calls the shared
  concern directly — same as `download` does today. Routing both through the hub client is the
  `docs/hub-api-single-path-plan.md` cleanup, not a Phase-4 one.
- **Exclude-list mode hides a project-level `.claude/`.** The agent state excludes are derived from
  the registry's `staticPaths`, so `.claude` is dropped in exclude-list mode — right for a service
  box whose agent writes state there, wrong for a non-git project that keeps its skills in
  `.claude/`. Gitignore mode is unaffected (that is why `dropExcludedInGitMode` is opt-in and only
  `clone` sets it). Revisit if someone hits it; an `--include <glob>` carve-in is the obvious answer.
- **remote-docker and digitalocean were not exercised.** The plan calls out remote-docker as the main
  consumer of the non-git leg. The code path is provider-neutral (`BoxFilePorts` over
  `exec`/`uploadPath`/`downloadPath`, which both implement) and docker + the hub routes were verified
  live, but neither VPS provider was run.

## From host-side integration testing (2026-09-02)

- **`agentbox relay restart` does not restart the hub-embedded relay.** It reports
  `hub (serving the relay) running` and exits 0, but the hub PID is unchanged, so
  loops registered in `startRelayDaemon` (autopause, keepalive, the new persistent
  boot reconcile) are NOT re-run. Only `hub restart` actually recycles them. This made
  a working boot-reconcile look broken during testing. Either make `relay restart`
  restart the hub when the hub owns the relay, or say so in its output.
- **`agentbox status <box> --json` reports `"name": null`** for a box with no
  `displayName`, while `agentbox list` shows the real name. Fall back to `name`.
- **`BoxRecord.provider` is `null` on a docker box** created through the hub queue
  (the loops cope via `box.provider ?? 'docker'`, so this is cosmetic — but a null
  where `'docker'` is meant will bite something eventually).

## From Phases 6-8 (openclaw as a service agent, 2026-09-02)

- **`AgentSyncSpec.credential` should be optional.** OpenClaw has no host-side credential at all —
  its gateway token is generated per box and must never leave it — but the field is required, so the
  row names a path nothing writes (`~/.openclaw/agentbox-credential.json`) to make every credential
  mechanism a clean no-op. That is honest but indirect, and it forces a `WATCHED_CREDENTIALS` row in
  ctl for a file that will never exist. Making the field optional touches ~10 shared call sites
  (`agent-descriptor`, `credentials-watcher`, the cloud `agentSpecs()`, the credentials concern, the
  relay fanout, the hub catalog); worth doing when a second credential-less agent appears.
- **`agentbox-ctl reload` does not re-run a service agent's render.** Reload applies the *unit*
  diff, and the render task's definition has not changed when only the overlay block has — so
  editing `openclaw:` needs `agentbox-ctl run-task openclaw-render --force`. Teaching reload to
  re-run a render task whose overlay block changed would make the documented "editing the overlay is
  a live operation" true without the extra step.
- **`agentbox <agent> url` reads the token with a raw `cat` over `provider.exec`.** Fine and
  degradation-safe, but it means the value crosses the exec transport in plaintext output. Nothing
  logs it, and every provider's exec is already an authenticated channel, so this is a note rather
  than a defect.
- **The AGENT column item from Phase 2 is still open**, and now has a real service agent to be seen
  on — `agentbox list` reports nothing for an openclaw box because it has no tmux session. See the
  Phases 2-3 entry above.
- ~~**`--persistent` does not exist yet (Phase 1).**~~ **Done** (2026-09-02): a
  `caps.surface: 'service'` row now creates a persistent box by default, derived in
  `resolveCreatePersistent` (`packages/core/src/persistent.ts`) from the surface rather than from
  an agent id, on both the CLI's `provider.create` and the hub's `POST /api/v1/boxes`.
  `--no-persistent` opts out and the e2b/vercel refusal fires before the create.
- **Channel pairing is still unverified end to end.** Carried over from Phase 0: `openclaw channels
  add --use-env` needs a real bot token, and the smoke here stopped at a healthy gateway with no
  channels. Wire one before calling OpenClaw support complete.

## From the upload/clone API conversion (2026-09-02)

- **`POST /boxes/:id/upload` has no progress stream.** The route is synchronous, so the per-file
  lines `uploadWorkspaceToBox` emits go to the hub's stdout (`~/.agentbox/hub.log`) and the CLI
  shows nothing until it returns. Fine for a normal workspace, thin for a large non-git one. The
  fix is the shape `clone` already has — return a job id and stream `GET /jobs/{id}/logs` — but
  that turns a one-round-trip op into a queued one, so it is worth doing only if a slow upload is
  actually observed.
- **`agentbox upload` is refused when a remote control box owns the box.** The hub reads the host
  side of the workspace off its own disk, so a control box could only ever push *its* copy of the
  project. Refusing is the honest answer today; making it work means a client→hub file upload
  (custody blobs are the existing primitive) and belongs with the wider IO-plane move that
  `docs/hub-api-single-path-plan.md` defers.
- **`agentbox <agent> --no-persistent` on an EXISTING box is silently inert.** The service command
  is create-or-resume, and the flag only reaches the create leg; resuming an always-on box with
  `--no-persistent` neither changes the record nor warns. Either warn, or make it a real edit of
  `BoxRecord.persistent`.
- **`agentbox <agent> stop` still goes through `provider.exec`.** Unchanged by this pass; the hub's
  services route exposes `restart` but not `stop`. Same item as before — the route belongs behind
  `/api/v1` like every other box operation.
- **The hub queue worker cannot build a SERVICE-agent box.** `POST /api/v1/boxes` with
  `agent: "openclaw"` validates (the registry is the accept-list) and enqueues a job carrying the
  right `createOpts` — including the derived `persistent: true`, verified — but the worker dies with
  `unknown agent kind: openclaw`. Two causes, both fail-closed by design: `toSyncKind`
  (`packages/core/src/sync/agent-kind.ts`) only accepts `BUILTIN_AGENT_KINDS`, which lists the four
  TUI agents, and `_run-queued-job.ts`'s session dispatch has no branch for a surface with no tmux
  session. The fix is the same shape as `job.noAgent`: skip the session leg for a
  `caps.surface: 'service'` agent, and widen the wire-kind boundary (which also blocks every
  `agentbox agent add` plugin agent). Until then a service box is created by the CLI's own
  `provider.create` and the hub-queue path is dead for it. Pre-existing — nothing used this path
  before — but it is now the last thing between a service agent and the web UI / tray.
- **`opts.envFiles` / `opts.withEnv` on `POST /api/v1/boxes` name files on the HUB's disk, not the
  caller's.** Found by the cwd/`$HOME` audit that followed the `--into` fix; same class, left
  unfixed there because it is not the same one-line boundary fix. The entries are workspace-relative
  paths (`.env`, `apps/web/.env.local`) produced by the CLI wizard scanning the **user's** tree
  (`scanHostEnvFiles(proj.root, …)`, `packages/sandbox-core/src/sync/concerns/env.ts:115`), and they
  are re-resolved against the workspace root on whichever machine performs the create — the hub's,
  now that create is behind the API. **The concrete failure against a remote control box:** the user
  ticks `.env` in the wizard, the *string* travels, and the control box resolves it inside its own
  fresh `git clone` — where `.env` does not exist, because it is gitignored and the untracked seed
  excludes ignored paths by design (see the comment at `apps/cli/src/commands/create.ts:196`). The
  worker's `copyHostFilesToBox` copies 0/1, logs `copied 0/1 selected env/config file(s)` into the
  queue log, and the create **succeeds** — so the box comes up missing the file the user explicitly
  chose, with nothing on the terminal saying so. An absolute or `..`-escaping entry is worse and just
  as accepted: `parseCreateBoxOpts` only checks that `envFiles` is a string array, so a same-named
  file that happens to exist on the hub's disk would be copied into the box instead of the caller's.
  Latent for the CLI today — `remoteOpts` in `create.ts` does not forward `envFiles` — but
  `withEnv: true` IS forwarded and expands to `DEFAULT_ENV_PATTERNS` against the hub's workspace with
  exactly the same result, and nothing stops the web UI, the tray or any API client from sending
  `envFiles` directly.
  Why it is not the `--into` fix: a path cannot be resolved client-side into a file's *contents*, so
  making this honest means either uploading the bytes (custody blobs / the create seed, which is what
  `carry:` already does — today the only route by which a gitignored file reaches a hub-built box) or
  refusing the field outright when the hub is not the caller's machine. Cheap partial hardening in
  the meantime: reject absolute and `..`-escaping entries at the validator, and have the worker fail
  loudly rather than log `copied 0/N` and continue.
