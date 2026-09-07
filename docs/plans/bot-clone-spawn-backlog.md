# Bot backup / restore / spawn — backlog

Findings and deferred items from implementing
[`bot-clone-spawn-plan.md`](./bot-clone-spawn-plan.md). Each phase appends here
rather than sidequesting. Promote an item to the plan if it turns out to be
load-bearing.

## From Phase 2 (restore, 2026-09-07)

### Measured, and now encoded

- **A restore MUST delete the target's stale write-ahead logs first.** Copying a
  bundle's `openclaw.sqlite` over a fresh box's left that box's own
  `openclaw.sqlite-wal`/`-shm` beside it, and the gateway then refused to start —
  `SQLite integrity_check failed for …/openclaw.sqlite: row 1 missing from index
  idx_gateway_boot_lifecycle_started` — restarting on a backoff loop forever. The
  naive "rsync the state dir in" implementation ships a broken bot. Only the
  sidecars of a database the bundle actually replaces are removed: one belonging
  to a database we are not overwriting may hold the only copy of committed rows.
- **`run_once: 'marker'` is what makes the ordering easy.** The marker is keyed
  by the task's command hash and lives on the box ROOTFS
  (`/var/lib/agentbox/tasks/openclaw-onboard`), not in the agent's config volume,
  so onboard runs once on every fresh box whatever the volume holds. Restoring
  *after* it is therefore deterministic and needs no create-path hook, and the
  marker keeps onboard away from the restored identity on every later boot —
  verified across a full `stop`/`start` of the box.
- **`listBackups` counted a restore's live `workspace/` as a backup.** A Phase 1
  bug the restore exposed: the filter was "any dir that is not `latest`", and
  `workspace` sorts after every stamp, so it would have become the newest
  "backup" the prune must keep. Now matched against the stamp shape.

- **The cross-provider claim is now measured, not argued.** A bundle captured on
  a docker box restored onto a Hetzner VPS with the same gateway token, the same
  automation row and a clean `openclaw config validate` — which is what a
  file-shaped backup is for and what a provider snapshot cannot do.

### Open

- **PoC question 4 is not answerable locally.** "Does OpenClaw refuse when a
  second box holds the same identity while the first still runs?" needs a real
  channel: two gateways on one host with no channel configured never collide, and
  the collision that matters is at the channel provider. The guard is a hard
  error with `--force` until someone can measure it — the safe default, but
  chosen rather than measured.
- **`--restore` does not work against a remote hub.** The bundle is a directory
  on the user's machine and the create API carries a `projectId`, never a path
  (`hub-backend.ts` resolves the workspace from the hub's own registry — "never
  trust a client path"). A local hub is the same machine, so the ordinary path
  works; a control box would need the bundle uploaded first. Not refused
  explicitly yet: the create simply fails to find the project.
- **`download` is still the one CLI-inline command**, and `--backup`/`--restore`
  join it there. Moving the whole command behind `/api/v1` — with a state-push
  route the restore can use — is one change, not three; `upload` has already
  moved, `download` has no route at all.
- **`agentbox <agent> stop` still bypasses the hub** (the services routes expose
  `restart` but not `stop`), so the restore's stop step is a `provider.exec`.
  Same item as in the service-boxes backlog; the restore is now a second caller.
- **The source-box guard only knows the box the bundle came from.** It reads
  `manifest.boxId`, so a *second* restore of the same bundle into a different
  `--into` directory is not refused — the two live bots would share an identity.
  Restoring twice into the SAME directory is refused (a box already runs on it).
  Recording the bundle on the box record would close the gap.
- **Hetzner `nbg1` had no `cx23` capacity** during this work, and the
  service-agent command has no `--location` flag (it carries a deliberately small
  subset of the create flags), so the retry went through
  `config set box.hetznerLocation fsn1`. Worth adding if VPS restores become
  routine.
- **Hermes' shape is still unmeasured.** Its state dir and identity files need
  the same table row openclaw has before a `clone:`/restore story can cover it.

## From Phases 3 and 4 (spawn + the identity wizard, 2026-09-07)

### Measured, and now encoded

- **A clone of a service-agent box has to RUN that agent.** Keeping
  `agent: 'none'` (the historical clone contract) meant the per-box secrets had
  no create to ride into, and no later step would ever carry them: the second
  "bot" was a directory. `prepareClone` reads `caps.surface` and sets the agent
  itself, so the ordinary create applies `perBoxCarry` on every provider.
- **The identity render cannot be an in-box `run_once: { check }` task.** The
  only available check is "does `SOUL.md` exist", and the clone has just copied
  one — so it would never fire. Host-side it is a five-line pass over the
  exported dir, before the box exists.
- **`optional` was the vocabulary `required:` was reaching for.** Same field,
  read differently by the two callers: honoured on a create, ignored on a clone.
  Worth remembering the next time a spec field looks like it needs a new flag.
- **The clone refusal runs before the export**, so a missing secrets file leaves
  no directory, no registered project and no box. Tested by mutation.

### Open

- **`agentbox clone` has no `--with-secrets` or equivalent**, so the per-box file
  must be created by hand before the clone. A prompt (the carry gate's shape)
  or a `--secrets-from <file>` would close it, but neither is worth building
  until someone has spawned bots often enough to be annoyed.
- **The nudge assumes the bot reads its bootstrap files on the first turn.**
  True for openclaw's `bootstrap-extra-files`, unverified for anything else. An
  agent whose surface ignores them gets no nudge and no error.
- **A rule-set is only as good as the bot's judgement of its own name.** The
  skill refuses literals under three characters and warns on common words, but a
  bot named "Max" will still produce a rule the user has to review. There is no
  dry-run that shows what a rule WOULD rewrite before a clone applies it —
  `agentbox clone --dry-run` would be the natural home.
- **The identity skill needs a re-bake to reach existing snapshots.** Cloud bases
  pick it up through the `_shared` upload fallback on the next `prepare`; a
  docker base rebuilds locally. Until then the task's `[ -f ]` guard means the
  nudge is simply absent — never an error, but also never a prompt.
- **Only docker is live-verified.** The full `ada` -> `bea` sequence ran on
  docker (see the plan's Phase 3 notes). The cloud `applyCarry` leg carries the
  per-box entry through the same `withPerBoxCarry` call, but no cloud clone has
  actually run — hetzner is the one worth doing, since it is the other provider
  a bot is meant to live on.
- **`agentbox-ctl run-task --force` returns as soon as the task is RUNNING.**
  Not a bug, but it cost a false negative while verifying the nudge: a check that
  greps the regenerated file immediately reads the previous content. Wait for the
  task to leave `running` (this one takes ~10-15s, most of it the openclaw config
  patch) before asserting on its output.
