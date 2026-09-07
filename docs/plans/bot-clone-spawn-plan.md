# Bot backup, restore and spawn — plan

Status: **all four phases done** (backup, restore, spawn, the identity wizard).
Written 2026-09-07 after the
`download` fix (#372) and the openclaw box-context task (#371) landed on
`nightly`.

One session per phase. Keep the findings of each phase in
[`bot-clone-spawn-backlog.md`](./bot-clone-spawn-backlog.md) as they appear,
not as end-of-PR cleanup.

---

## Goal

A service bot (openclaw today, hermes next) is a **workspace + an agent state
dir + a handful of per-bot secrets**. Today AgentBox can pull the workspace
(`download`) and copy it into a fresh box (`clone`), and that is all. This plan
adds the three things a bot operator actually needs:

1. **Backup** a running bot to its project, so it can be recreated after the
   box is lost or moved to another provider. Provider snapshots cannot do this;
   they are provider-native.
2. **Spawn** a second bot from the same workspace: same files, same agent, a
   fresh gateway identity, its **own** channel tokens, and a `SOUL.md` /
   `IDENTITY.md` that carry a different name.
3. Keep the project as the **template** and each bot's backup **inside the
   project** under `.agentbox/`, so the source of truth is the user's tree and
   never `~/.agentbox/` (which holds copies for AgentBox's own use only).

Sharing is not a phase: the live case is the hub (a CLI targeting an exposed
hub can `download` from the box), the offline case is the backup dir itself.

---

## Established facts

Measured against the code (and, where marked, a live box) on 2026-09-07.

| Fact | Where | Consequence |
|---|---|---|
| `download` drops `.agentbox` in both modes | `GIT_MODE_EXCLUDE_DIRS` + `workspaceExcludes()` in `packages/sandbox-core/src/sync/concerns/workspace-files.ts` | A backup under `<project>/.agentbox/` is never clobbered by a later pull. |
| On a **git** project a gitignored path is never seeded | untracked carry is `git ls-files --others --exclude-standard` (`workspace-seed.ts:906`, `git.ts:268`) | `.agentbox/bots/` in `.gitignore` stays on the host. |
| On a **gitless** project the seed tars the whole dir with no exclude | docker: `seedWorkspaceFromDir` (`in-box-git.ts:643`, `tar -C <host> -cf - .`); cloud: `seedFromTar` (`workspace-seed.ts:958`, `tar -C <host> -czf … .`) | Every bot's backup would ship into every new box. **Phase 1 must add the seed-side exclude before anything is written there.** |
| The in-box `/workspace/.agentbox/` is regenerated (`AGENTS.md` box facts, #371) | `openclaw-agentbox-env` task | Same name, opposite ownership: host `.agentbox/` is durable and the user's; box `.agentbox/` is disposable. The invariant is **`.agentbox/` never crosses the boundary in either direction.** |
| The openclaw push excludes are the bot's **identity** | `staticPaths[0].exclude` in `packages/agent-registry/src/specs/openclaw.ts` (`openclaw.json`, `.bak`, `config-journal-fingerprint.key`, `.agentbox-overlay.json`, `state`, `migration`, `tmp`) | A backup is the one case that must **keep** them; `tmp` stays out (uid-keyed lock dir). |
| `clone` already gives a fresh gateway token | onboard regenerates it; `clone` copies no state dir | Spawn needs nothing for the gateway identity — only channel tokens and the identity files. |
| `clone` runs entirely behind the hub (`POST /api/v1/boxes/:id/clone`) and creates with `agent: 'none'` | `apps/hub/app/(dashboard)/api/v1/boxes/[id]/clone/route.ts`; service-boxes backlog | Any per-agent clone logic must be executable **by the hub**, which loads no agent modules. |
| Agent specs are **data**; `agentbox agent add <pkg>` snapshots them into `~/.agentbox/agents.json` | `spec-purity.test.ts`, `plugin-agents.test.ts` | New per-agent behaviour is a declarative spec field, not a code hook. |
| A replacement mechanism already exists | `replacements:` in `agentbox.yaml` (`packages/ctl/schema/agentbox.schema.json`), applied by `carry[].rules` on the host and `agentbox-ctl render --rules/--env` in the box; placeholders `{{AGENTBOX_BOX_NAME}}`, `{{AGENTBOX_AUTO_SECRET}}` | No template language. `SOUL.md`/`IDENTITY.md` are rendered through a named rule-set. |
| Channel tokens ride `carry:` into a 0600 `~/.openclaw/.env` and are referenced by name in the overlay | `examples/openclaw-gateway/agentbox.yaml` | A per-bot token is a per-bot **source path**, not a new secret channel. |
| The box already gets a setup skill (`/opt/agentbox/skills/agentbox-setup/SKILL.md`, copied from `/usr/local/share/agentbox/setup-guide.md`) | `openclaw.ts:66-172`; sources under `apps/cli/runtime/_shared/agentbox-setup-skill.md` | The identity wizard is a second skill of the same shape. |

### The PoC gate — measured 2026-09-07

- **Restoring `openclaw.json` + `state/` into a fresh box revives the identity.**
  Verified: same gateway token, the same automation row (same id) back in the
  restored database, `openclaw config validate` clean. **But only after the
  target's stale `-wal`/`-shm` are removed** — see the Phase 2 notes.
- A restored bot with the **same** identity as a still-running box: **not
  answerable locally.** Two gateways on one host with no channel configured never
  collide, and the collision that matters is at the channel provider. The guard
  stays a hard error with `--force`, chosen rather than measured.
- `agentbox-ctl render --env` substitutes `{{AGENTBOX_BOX_NAME}}` with the box
  name ctl sees (not the container name) on every provider.
- hermes' state dir and identity files, so its row can be written alongside
  openclaw's rather than guessed.

---

## Decisions

1. **Backups live in the project: `<project>/.agentbox/bots/<bot>/<stamp>/`,
   and the whole of `<project>/.agentbox/` is gitignored** — AgentBox appends
   the entry on the first backup. `manifest.json`, `workspace/` and `state/`
   sit inside each timestamped dir; backups are timestamped and the newest
   `--keep <n>` (default 3) are kept, with a relative `latest` symlink.

   The earlier idea of committing `workspace/` while ignoring `state/` was
   **rejected on evidence**: the git seed is a worktree checkout of *tracked*
   files, so a committed backup is checked out into every new box and no
   tar-level exclude can stop it. A user who wants history runs `git init`
   inside a bot's dir; a nested repo in an ignored dir is invisible to the
   project repo. Rotation was rejected for timestamps because a backup taken
   while a bot was broken must not destroy the last good one.
2. **`agentbox download --backup`** is the backup command. Not a new verb: it
   is the same staging with a different destination, no agent-file prompt
   (a backup takes everything), and the state half added.
3. **Restore is a create**, not an upload: `agentbox openclaw --restore <name>`
   (and `agentbox create --restore` for the agentless shape). The seed comes
   from `.agentbox/bots/<name>/workspace/` instead of the project tree; the
   state half is pushed through the existing `staticPaths` mechanism with the
   identity excludes lifted. Refuses while the source box is still running
   unless `--force`.
4. **Per-agent spawn behaviour is a declarative `clone:` field on the spec**,
   folding in `workspaceArtifacts` from #372:
   ```ts
   clone?: {
     drop?: readonly string[];        // workspace files not copied (AGENTS.md, USER.md)
     render?: readonly string[];      // copied, then rendered with the bot's rule-set (SOUL.md, IDENTITY.md)
     perBoxCarry?: readonly { src: string; dest: string; mode?: number; required?: boolean }[];
   }
   ```
   `src` may contain `{{AGENTBOX_BOX_NAME}}`. A `required` source that is
   missing fails the clone naming the path to fill — that is what makes
   per-bot tokens the default rather than a convention.
5. **The identity rule-set is written by the bot itself** through a
   `agentbox-identity` skill that runs once after onboarding (sentinel, like
   box facts), reads `SOUL.md`/`IDENTITY.md`, and writes a `replacements:`
   rule-set into `agentbox.yaml` scoped to those two files with whole-word
   `from` values. The user reviews it like any other edit to their yaml.
6. **Rendered files are generated files**: rendered only when the target is
   absent, so a bot that edits its own `SOUL.md` is not reset on reboot.
7. **`~/.agentbox/clones/<name>` stays** as the default workspace for a spawn
   with no project of its own, but a spawn from a project defaults `--into`
   to `<project>/.agentbox/bots/<name>/workspace/`, so the template and its
   instances share one tree.

Rejected: a code hook for clone cleanup (the hub cannot run it, and a package
agent would need a module load on every path); a template language for
identity files (`replacements:` already exists); timestamped backup dirs
(history is git's job; rotation is enough for the state half).

---

## Phases

### Phase 1 — `.agentbox/` never crosses; `download --backup` — **DONE**

Shipped. What the implementation found that the plan had not:

- **The leak was bigger than the two no-git seeds.** The `git ls-files --others`
  carry-over lists (docker, cloud, and the hub's custody seed) ship an untracked
  `.agentbox/` too, so a project whose gitignore entry was missing or edited
  still leaked. Reproduced live: a box created before the fix had the host's
  gateway token at `/workspace/.agentbox/bots/ada/*/state/openclaw.json`.
- **Neither tar can anchor an exclude.** Measured on bsdtar 3.5.3;
  `--exclude=./.agentbox` still drops `sub/.agentbox`. The seed matches at any
  depth, which is also what a monorepo sub-project's backup wants.
- **`git check-ignore .agentbox` exits 1 against a `.agentbox/` rule** — a
  trailing-slash pattern matches directories only and the path does not exist
  yet. The probe has to be a path *inside* the dir.
- **rsync creates only the last component of its destination**, so the bundle's
  directories must exist before the pull, dry-run included.
- **`find` discovered a database nobody would have listed by hand**:
  `agents/main/agent/openclaw-agent.sqlite`, beside the expected
  `state/openclaw.sqlite`.
- The `--backup` path is a mode of `download`, which is still the one CLI
  command that has not moved behind `/api/v1`. The orchestration lives in
  `sandbox-core` so a hub route reuses it rather than reimplementing.

Live-verified on docker (git and gitless), e2b and **hetzner** — the state half
included. Hetzner needed its own fix first: `boxRunEnv` never reached a VPS box
(blocker 1 in [`service-boxes-plan.md`](./service-boxes-plan.md)), so openclaw
onboarded against `~/.openclaw/workspace` and a backup taken there would have
captured a bot that was not working on the project at all. An agent's run-env now
rides the units it contributes, which fixes every provider with one rule and
needs no re-bake.

<details>
<summary>Original plan</summary>

### Phase 1 — `.agentbox/` never crosses; `download --backup`

**Seed exclude.** Both gitless seeds gain `--exclude=./.agentbox` (docker
`seedWorkspaceFromDir`, cloud `seedFromTar`), and `overlayHostDirIntoBox` (the
`sync` non-git overlay) skips it too. Pin with a unit test per seed that builds
the tar argv, and one behavioural test that tars a temp dir and asserts the
member list. Document the invariant in `docs/sync-architecture.md` next to
the selection ⊆ staging one.

**The flag.** `download --backup [--name <bot>]`:
- destination `<project>/.agentbox/bots/<box-name>/workspace/`, created if
  absent; `--include-node-modules` still honoured; no artifact prompt.
- state half: a new `agentStateBackupPaths(agentId)` derives from the spec's
  `staticPaths` with `exclude` reduced to the uid-keyed entries only (`tmp`),
  pulled with the existing box-file ports into `state/<boxDir-basename>/`.
- `.gitignore` gets `.agentbox/bots/*/state/` if absent (only if the project
  is a git repo). Print what was written and where.
- `manifest.json`.
- The cloud path stages through `stageBoxWorkspace`; docker through
  `refreshExport`. Both already exist; the only new piece is the second
  destination and the state pull.

**Files:** `apps/cli/src/commands/download.ts`, `packages/sandbox-core/src/sync/concerns/workspace-pull.ts`
(a `destDir` override), `packages/sandbox-core/src/sync/concerns/credentials.ts`
or a new `agent-state.ts` for the backup path derivation, both seeds, docs
(`sync-and-git.mdx`, `cli.mdx`, `sync-architecture.md`).

**Verify (live, docker + one cloud):** run a bot, add a channel, `download
--backup`; `ls .agentbox/bots/<name>/state/` shows `openclaw.json`; `git status`
shows `workspace/` as new files and `state/` ignored; create a new box from
the same project and confirm `/workspace/.agentbox/bots` does **not** exist in
it (gitless project — copy `examples/openclaw-gateway` without `.git`).

</details>

### Phase 2 — restore — **DONE**

Shipped as `--restore <bot>` on `agentbox create` and on the service-agent
commands. What the implementation found that the plan had not:

- **The PoC's real answer was a bug, not a yes.** Pushing the bundle's `state/`
  into a fresh box and restarting the gateway does revive the identity — but only
  after the target's own `-wal`/`-shm` are removed. Leaving them produced
  `SQLite integrity_check failed … row 1 missing from index` and a permanent
  restart loop. That deletion is now the first thing `restoreAgentState` does,
  scoped to the databases the bundle actually replaces.
- **No create-path surgery was needed at all.** The plan expected to write the
  state in before onboard. `run_once: 'marker'` makes that impossible *and*
  unnecessary: the marker lives on the box rootfs, not in the config volume, so
  onboard runs once on every fresh box regardless — and, having run, never
  touches the restored identity again. Restore therefore runs after the service
  is up: stop, push, restart. One order, every provider, no provider code.
- **The state push must NOT go through `agentPushExcludes`.** It adds
  `LIVE_DATABASE_EXCLUDES` unconditionally, which matches `*.sqlite*` — precisely
  what a restore exists to put back.
- **The workspace half is a create with no new plumbing.** The restored tree is
  the box's project, so it rides the ordinary create exactly as `clone`'s export
  dir does. `projectRoot` is that directory verbatim, never `findProjectRoot`'s
  answer — the restore dir lives under the ORIGINAL project's `.agentbox/`, so
  walking up would have seeded the box from the template project instead.
- **Phase 1 had a latent bug this exposed**: `listBackups` counted a restore's
  live `workspace/` as a backup, and it sorts after every stamp.

Live-verified end to end. On **docker**: same gateway token, the same automation
row (same id) in the restored database, `openclaw config validate` clean, and all
of it surviving a full box `stop`/`start`. On **hetzner**, which is the
acceptance test the plan named — a bundle captured on docker, restored onto a
VPS: same token, same automation, config valid, workspace intact. And
`create --restore` gives the workspace half alone, naming the agent whose
identity it did not bring. Findings and what is still open are in
[`bot-clone-spawn-backlog.md`](./bot-clone-spawn-backlog.md).

<details>
<summary>Original plan</summary>

PoC gate first (see above). Then:

- `--restore <name>` on `create` and on the service-agent commands. Resolves
  `<project>/.agentbox/bots/<name>/`, refuses if the manifest's box is still
  registered and running (`--force` overrides).
- Seed: the workspace half is the seed source (`seedWorkspaceFromDir` /
  `seedFromTar` already take a host dir; git projects reseed from the project
  as usual and overlay the workspace half on top, since the backup may be
  ahead of the commit).
- State: pushed via `staticPaths` with an `includeIdentity` flag on the push
  (the inverse of Phase 1's derivation), before the agent's onboard task runs
  — onboard must see the restored `openclaw.json` and skip generating a new
  one. Verify that openclaw's onboard is idempotent on an existing config;
  if not, the restore sets the task's `runOnce` marker.
- Provider switch: `--restore ada --provider hetzner` is the acceptance test.

**Verify:** back up on docker, destroy, `--restore` on docker → same gateway
token, channel still paired, memory intact; then `--restore --provider e2b`.
A box reaching `ready` proves nothing here — send a message through the
channel.

</details>

### Phase 3 — the `clone:` spec field and per-bot carry — **DONE**

Shipped. What the implementation found that the plan had not:

- **The clone had to start running the agent.** The plan kept `clone`'s
  `agent: 'none'` and left `perBoxCarry` to be applied by whatever added the
  agent later. But a bot's box IS the bot: an agentless copy of an openclaw
  workspace is a directory, and there was no second step that would ever carry
  the secrets in. `prepareClone` now picks the source's agent when its
  `caps.surface === 'service'`, and the ordinary create applies the per-box
  entries — one path, every provider.
- **The render belongs on the host, not in the box.** The plan preferred an
  in-box `run_once: { check }` task. It cannot work as written: the check would
  have to be "does `SOUL.md` exist", and the clone has just copied one, so it
  never fires. Host-side in `prepareClone` the exported `agentbox.yaml` is
  already on disk, the box name is known, and Decision 6 becomes true by
  construction — after the clone these are ordinary files nothing rewrites again.
- **`required: true` was not needed.** carry already has `optional`, so the rule
  is a sentence rather than a field: `optional` is honoured on a create and
  ignored on a clone. A first bot has nobody to collide with; a clone is the
  collision, and it refuses BEFORE the export, so nothing is left behind.
- **No `word: true` on `ReplaceRule` either.** `regex: true` with `\bAda\b`
  already gives whole-word matching, and the wizard writes exactly that — one
  less thing in the schema, the engine and the ctl CLI.
- **`dropExcludedInGitMode` was carrying two jobs.** It both applied the exclude
  list in git mode and sourced the artifact drop. The drop is now
  `clone.drop`, scoped to the box's own agent rather than the registry-wide
  union — a claude rule can no longer shape an openclaw box's clone.

<details>
<summary>Original plan</summary>


- `AgentSyncSpec.clone` as in Decision 4; `workspaceArtifacts` folds into
  `clone.drop` + `clone.render` (delete the old field; AgentBox is unreleased).
- `stageBoxWorkspace`'s `dropExcludedInGitMode` branch reads `clone.drop`;
  `clone.render` files are copied and then rendered on the **host** side of
  the clone (the hub already stages the export) with `agentbox-ctl render
  --rules <set> --env` semantics ported to the host, or by running the render
  in the new box's first boot behind a sentinel. Prefer the in-box render: the
  rule-set lives in the workspace's `agentbox.yaml`, and ctl already has the
  command.
- `perBoxCarry` is applied by the create path exactly like `carry:` entries,
  after `{{AGENTBOX_BOX_NAME}}` substitution; `required` missing → fail with
  the path.
- openclaw's row: `drop: ['AGENTS.md','USER.md']`, `render: ['SOUL.md','IDENTITY.md']`,
  `perBoxCarry: [{ src: '~/.agentbox/openclaw/{{AGENTBOX_BOX_NAME}}.env', dest: '~/.openclaw/.env', mode: 0o600, required: true }]`.
  Hermes' row once its shape is measured.
- `clone --into` defaults to `<project>/.agentbox/bots/<name>/workspace/` when
  the source box has a project root; `~/.agentbox/clones/<name>` otherwise.
- `spec-purity.test.ts` keeps passing (all data); `plugin-agents.test.ts`
  gains a package that declares `clone:`.

**Verify:** clone bot `ada` to `bea` with no `bea.env` → clear failure naming
`~/.agentbox/openclaw/bea.env`; create the file → clone succeeds, `bea`'s
`SOUL.md` names Bea, `openclaw.json` differs, `ada`'s channel is untouched.

</details>

### Phase 4 — the identity wizard skill — **DONE**

Shipped as the `agentbox-identity` skill, baked beside the setup guide on every
provider. What the implementation found:

- **There was no "run once, ever" sentinel to copy.** `openclaw-agentbox-env`
  deliberately has no `runOnce`, and the only marker in play is
  `openclaw-onboard`'s. Rather than introduce the first one, the nudge is a
  paragraph appended to the box facts *while* `agentbox.yaml` declares no
  `identity` rule-set. The yaml is the only state: the file is regenerated every
  boot, so the nudge disappears by itself and nothing can go stale.
- **A supervisor task could not do this job.** Writing the rules means reading
  your own `SOUL.md` and deciding which words are your name — a judgement, on a
  turn. Driving `openclaw agent` from a task would also need a model credential
  in the box at boot, which is a separate unshipped thing.
- Verified by running the generated script against a scratch workspace: the
  nudge appears without the sentinel, is gone after it, and the box facts
  survive both.

<details>
<summary>Original plan</summary>


- New `agentbox-identity` skill beside `agentbox-setup` in
  `apps/cli/runtime/_shared/`, staged into the image like the setup guide, and
  installed by the same `openclaw-agentbox-env` task (one more `install -m
  0644`).
- The skill instructs the agent to: read `SOUL.md`/`IDENTITY.md`, extract the
  bot's name and any other identity literals, and write
  `replacements: { identity: [{ from: '<name>', to: '{{AGENTBOX_BOX_NAME}}', word: true }] }`
  into `agentbox.yaml`, plus `openclaw: { … }` nothing — the overlay is not
  touched. Runs once behind a `agentbox:identity-rules` sentinel in the yaml.
- `replaceRule` schema gains `word?: boolean` (whole-word match) and the
  render honours it; `clone.render` uses the `identity` rule-set by name.
- The user gets the yaml diff on the next `download`.

**Verify:** fresh openclaw box, let it onboard and name itself; the yaml gains
the rule-set; clone → the clone's `SOUL.md` carries the new name and nothing
else changed (diff the two files).

</details>

---

## Open questions

- Should the workspace half of a backup default to **committed** or **ignored**?
  Decision 1 says committable; the first real bot will tell whether memory
  files are too noisy for a repo.
- `download --backup` on a **git** project: the workspace half duplicates what
  the project already tracks. It is still right (the bot's memory is not in
  the project's git), but the docs must say the backup is the *box's* tree,
  not a second checkout.
- Does the hub-side clone route need a `bots/` listing for the web UI and the
  tray (`GET /api/v1/projects/:id/bots`)? Not before Phase 3 lands.
