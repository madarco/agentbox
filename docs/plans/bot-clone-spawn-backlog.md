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
- **Hermes' shape is still unmeasured.** Its state dir and identity files need
  the same table row openclaw has before a `clone:`/restore story can cover it.
