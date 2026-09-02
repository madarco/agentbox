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

- **`--persistent` is not on the agent commands yet.** `create` has it; `agentbox claude|codex|
  opencode|pi` do not, because the shared agent-flag table
  (`apps/cli/src/agents/command/options.ts`) was owned by another box during this phase. The
  capability is still reachable there — `createBox`/`createCloudProvider` fall back to the
  effective `box.persistent`, so `agentbox config set box.persistent true --project` applies to an
  agent create. Add the flag when the agent-command files are free.
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
  (`agentbox sync` silently clobbered the box's `shared.txt`) and fixed in both; pinned by
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
- **`agentbox sync` runs inline in the CLI, not through the hub.** The hub route exists
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
- **`--persistent` does not exist yet (Phase 1).** `agentbox openclaw` is exactly the workload that
  needs it: a gateway box will be autopaused and idle-lapsed like any other, and it has no reporting
  agent so every idle heuristic reads it as abandoned. The service-agent command should imply
  `--persistent` once Phase 1 lands.
- **Channel pairing is still unverified end to end.** Carried over from Phase 0: `openclaw channels
  add --use-env` needs a real bot token, and the smoke here stopped at a healthy gateway with no
  channels. Wire one before calling OpenClaw support complete.
