# Bot backup, restore and spawn — plan

Status: **not started.** Written 2026-09-07 after the `download` fix (#372)
and the openclaw box-context task (#371) landed on `nightly`.

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

### To verify live before Phase 2 (PoC gate)

These are assumed, not measured. Each is cheap to check on a docker box and
changes the design if wrong.

- Restoring `openclaw.json` + `state/` into a **fresh** box revives the channel
  pairings and sessions, with nothing else (no `migration`, no `tmp`).
- A restored bot with the **same** identity as a still-running box is actually
  refused by openclaw (or misbehaves) — this decides whether "refuse restore
  while the source runs" is a hard error or a warning.
- `agentbox-ctl render --env` substitutes `{{AGENTBOX_BOX_NAME}}` with the box
  name ctl sees (not the container name) on every provider.
- hermes' state dir and identity files, so its row can be written alongside
  openclaw's rather than guessed.

---

## Decisions

1. **Backups live in the project: `<project>/.agentbox/bots/<box-name>/`.**
   Two halves with different git fates:
   - `workspace/` — the pulled workspace. Committable; a bot's `SOUL.md` and
     memory get history for free.
   - `state/` — the agent state dir with the identity kept. Always gitignored
     (AgentBox writes the entry on first backup), 0600, never leaves the machine
     through git.
   `manifest.json` beside them records agent id, provider, box name, and time.
   One backup per bot, rotated 1-deep (`state.prev/`), like the logs. History
   of the workspace half is git's job.
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

### Phase 2 — restore

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

### Phase 3 — the `clone:` spec field and per-bot carry

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

### Phase 4 — the identity wizard skill

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
