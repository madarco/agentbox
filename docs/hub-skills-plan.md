# Skills in the hub — a hub-owned skills library

**Status:** Phase 0 done (2026-11-22), results in
[Phase 0 results](#phase-0-results): **go** on box-local delivery for all five
agents. The [owner direction](#owner-direction-2026-11-22) of the same day
changes the store (custody, not a new blob store), the first import (automatic,
from the PC) and adds the `agentbox skills` TUI. Phase 1 implemented (see
[`hub-skills-backlog.md`](./hub-skills-backlog.md) for what it left open);
Phases 1b+ not started.

Roadmap item 2 is "skills, memory and multiple LLM subscriptions in the hub".
Memory is planned in [`agent-history-plan.md`](./agent-history-plan.md),
subscriptions in [`llm-accounts-plan.md`](./llm-accounts-plan.md). This is the
third leg.

## Goal

A skill the user owns reaches every box they start: any provider, any agent,
created from any PC or from the web UI. It should not depend on which machine
happens to run the create. Concretely:

1. **One library, on the hub.** The hub is the source of truth for the user's
   skills (per user once teams land), not whatever `~/.agents` and
   `~/.claude/skills` happen to hold on the machine that runs the create.
2. **Many ways in:** a PC folder, a git repo, a plugin marketplace, the web UI.
3. **Every box, every agent.** One delivery path for all providers, including
   community ones, landing in each agent's native skill location.
4. **Selection.** A default set, narrowed or widened per workspace, project and
   box, and recorded on the box.
5. **Versions and updates.** Every skill version is content-addressed and
   pinned per box. An update reaches running boxes by a rule, not as a side
   effect of some other box's create.
6. **Visible.** The CLI, web UI and tray can show which skills a box has, and
   whether a newer version exists.

Out of scope: project skills committed to a repo (`.claude/skills/`,
`.agents/skills/` in the checkout). They already travel with git to every
provider, and the hub doesn't need to own them.

## What exists today

### How skills reach a box

Skills are not a concept of their own today. They ride inside each agent's
static config tree plus one shared tree, `~/.agents`:

| What | Host source | Box destination | Where |
|---|---|---|---|
| Cross-agent Agent Skills | `~/.agents/` (`skills/<name>/SKILL.md`, `.skill-lock.json` from the open `skills` CLI) | `/home/vscode/.agents` | `concerns/skills.ts` `seedAgentsVolume`; cloud: `host-stage.ts` `stageAgentsStaticForUpload` |
| claude skills, plugins, marketplaces | `~/.claude/` minus the spec's excludes; `skills/`, `plugins/cache`, `installed_plugins.json`, `known_marketplaces.json` all included | `~/.claude` | `agent-registry/src/specs/claude.ts` `staticPaths` |
| codex skills | `~/.codex/skills` (on a host with `~/.agents` these are symlinks into it, so excluded and purged in the box except `.system`); `.tmp/marketplaces/` carved in so in-box `codex plugin` works | `~/.codex` | `agent-codex/src/docker-sync.ts` (`skillsExclude` / `skillsPurge`), `specs/codex.ts` |
| opencode skills | `~/.config/opencode/skills` | volume `config/skills` (`OPENCODE_CONFIG_DIR`) | `specs/opencode.ts` |
| pi skills | `~/.pi/agent/skills` (symlinks resolved on the host, `rsync -L`) | `~/.pi/agent/skills` | `specs/pi.ts`, `agent-pi/src/host-stage.ts` |
| openclaw | none from the host; AgentBox's own skill under `/opt/agentbox/skills`, registered via `skills.load.extraDirs` | `/opt/agentbox/skills` | `specs/openclaw.ts` (`openclaw-agentbox-env` task) |
| AgentBox's own skills | baked `setup-guide.md` / `identity-skill.md` | claude `skills/agentbox-setup` via `seeds`; openclaw extraDirs | `specs/claude.ts` `SEED_SETUP_SKILL`, `seeds` |

The `agentbox-` prefix is reserved: `SKILL_EXCLUDE_PREFIXES` keeps AgentBox's
own skills out of the box→host pull. On the host, `agentbox install` writes
the `/agentbox` skill in three different native shapes: a claude skill, a codex
prompt (`~/.codex/prompts/agentbox.md`) and an opencode command
(`commands/agentbox.md`).

### Per provider

| Provider | When skills land | Refreshed |
|---|---|---|
| docker | every `create` / `agentbox <agent>`: host → shared volume rsync (`agentbox-agents-config`, `agentbox-<agent>-config`), additive, host wins, no `--delete` | on the next create of *any* box sharing the volume, so running boxes change underfoot |
| daytona, hetzner, vercel, e2b, digitalocean | baked into the base snapshot at `prepare` (`stageAllAgentStatic`) | only by re-running `prepare` |
| remote-docker | at every create (`seedsAgentStaticAtCreate` → `seedAgentStaticForCreate`), narrowed to the box's agents | per create |
| community plugins | whatever `createCloudProvider` does for their backend shape | same as their class |

### Box → host, box → box

`agentbox download <agent>` pulls box-created skills, agents, commands and the
plugin cache back to the host (`agent-pull.ts`, additive, never overwrites), and
`agent-propagate.ts` can push the same set to other boxes. There is no notion
of "this skill should exist everywhere". It is a one-off copy.

### What breaks

1. **Remote control box.** No skill files are ever in custody
   (`CUSTODY_SCOPES` = agents, projects, boxes, prepared). A hub-created cloud
   box carries the PC's skills only when it boots a snapshot the PC baked and
   shared (`prepared/<provider>.json`, see the
   [re-verification](#what-is-seeded-from-the-pc-today-re-verified)). Every
   other hub-created box (a re-bake on the control box, docker/remote-docker
   there) gets the skills in the _VPS's_ home directory, usually none. The
   System page lists only that VPS home ("Skills · this control box",
   `apps/hub/lib/host-carried.ts`), never what is inside an adopted snapshot.
2. **A second PC.** On a remote hub, PC B's skills reach nothing. On local
   hubs, each PC's boxes carry that PC's skills, so the same project behaves
   differently depending on which laptop created the box.
3. **Cloud bakes go stale without anyone noticing.** The base fingerprint is
   `variantFingerprint(contextSha256, { agentSettings, agents })`
   (e.g. `sandbox-e2b/src/prepare.ts`). It covers the build context, not the
   host's static config. A skill added after `prepare` is silently missing from
   every new cloud box, and nothing reports the base as stale. On a remote hub
   the bake also stages from the hub host's home, not the PC's.
4. **Docker can't select per box.** `~/.agents` and the claude config volume
   are shared by every box, so a skill is in all of them or none.
5. **Deletes never propagate.** The docker sync has no `--delete`. A skill
   removed on the host stays in the shared volume indefinitely.
6. **Running boxes are never updated deliberately.** Docker boxes change as a
   side effect of another create. Cloud boxes never change.
7. **Symlinked skills.** Skills commonly symlink into a checkout. The seeders
   dereference reachable links and exclude broken or out-of-tree ones
   (`findUnsyncableSymlinks`). That's correct, but a box can end up missing a
   file the host agent sees, and the user only finds out from a log line.
8. **No inventory.** Nothing records which skills, at which content, a given
   box received.

## Owner direction (2026-11-22)

Feedback on the first draft. It overrides the sections below where they
disagree, and the phases and decisions have been adjusted to match.

1. **Build on custody, not a parallel store.** The owner's understanding was
   that skills are already in hub custody, seeded from the PC the first time.
   Re-verified against the code below: they are not, but the PC _does_ already
   seed the control box at setup/deploy (credentials and bake records), so the
   library becomes a new `skills` custody scope pushed from the same place.
2. **First time: automatic. After that: explicit.** The first time a hub has an
   empty library, it is seeded from the PC with no prompt. From then on the hub
   is the source, and adding a skill takes an explicit action (TUI, flag, web).
3. **`agentbox skills` TUI** (@clack/prompts): local skills next to hub skills;
   pick local skills to upload; see what the hub stores (size, source PC,
   updated); discard stored skills; **download** hub skills to this PC, to align
   one PC with another. That settles the old "skills pull" open question as yes.
   Every action also has a non-interactive flag.
4. **Web UI** lists and discards stored skills.
5. Phase 0 measurements stand as measured.

### What is seeded from the PC today (re-verified)

| What | When | From | Lives at | Code |
| --- | --- | --- | --- | --- |
| Agent logins | end of `hub setup` / `hub deploy <provider>` / `hub expose` restart (`finalizeControlBoxState` → `syncAgentCredentials`), and on credential refresh (fan-out) | PC's `~/.agentbox/<agent>-credentials.json` | custody `agents/<agent>/<file>` | `apps/cli/src/commands/control-plane.ts`, `packages/relay/src/credentials-fanout.ts` |
| Bake records | the same end-of-setup step (`syncBakesWithControlBox` → `pushPreparedToCustody`); also after every hub-queued bake (`sharePreparedBase`) | PC's `~/.agentbox/<provider>-prepared.json` | custody `prepared/<provider>.json` — a **pointer** to a snapshot that lives at the cloud provider | `control-plane.ts`, `apps/cli/src/control-plane/prepared-custody.ts` |
| Project seed | on a PC-driven create of a project (best-effort, hash-skipped) | the working tree: untracked files + env files | custody `projects/<slug>/seed/{untracked,env}.tar.gz` + `manifest.json` | `packages/sandbox-cloud/src/custody-seed.ts` |
| `hub project push` | explicit command | named files (default `./.env`) | custody `projects/<slug>/<file>` | `control-plane.ts` |
| Skills | **never as files.** They ride _inside_ the PC's cloud snapshot, baked by `stageAllAgentStatic` at the PC's `prepare`. The control box adopts that snapshot when the record's `contextSha256` matches its own fingerprint (`hydratePreparedFromCustody`). | the PC's `~/.claude`, `~/.agents`, … at bake time | inside the provider snapshot; nothing in custody names them | `packages/sandbox-cloud/src/sync/agent-static.ts`, `bake-share.ts` |

So the owner's picture is half right. The first hub-created cloud box **does**
get the PC's skills, through the adopted snapshot. But:

- the fingerprint ignores skills, so the copy is whatever the PC had at its last
  bake, and nothing can tell how old it is;
- a fingerprint mismatch (a CLI version difference, a variant bake) makes the
  control box re-bake from its **own** home, and the skills silently disappear;
- docker and remote-docker boxes on the control box never get them;
- the hub can't list, update or delete them, because it has no copy.

Nothing exists to build a library on except custody itself. Custody fits:
streaming puts up to `relay.custodyMaxBlobBytes` (100 MiB default) already
carry `cp` tarballs, a DELETE route exists, the `/custody` web page already
lists entries, and the setup step that pushes credentials and bake records is
the natural place for the first skill seed.

## Shape

One new hub domain, `skills`, as a backend slice
(`apps/hub/lib/backend/skills.ts`, narrow `BackendDeps`; `hub-backend.ts` does
not grow). Four rules decide most of what follows:

- **The hub owns the library; edges only ship bytes.** PCs upload, the hub
  stores, and boxes pull. No create path reads `~/.agents` on whatever machine
  runs it once a library exists. The host copy is the fallback seed only while
  the library is empty or unreachable, the same posture the history plan takes
  for memory.
- **One canonical format, translated at the edge by data.** The library stores
  skills in the open Agent Skills layout (`<name>/SKILL.md` + files), which
  claude, codex, opencode, pi and openclaw all read in some location. Where
  each agent looks is declared on its `AgentSyncSpec`. No shared code knows an
  agent's name (`no-agent-named-exports.test.ts` must not grow).
- **The box pulls its skill set; nobody pushes into it.** ctl fetches the box's
  resolved set over the existing relay channel, the same way it fetches
  `agents.list` and `tool.list`, and materializes it. Every provider, including
  community ones, gets skills with no provider code. Updates go through the
  same pull.
- **The API is the only surface.** CLI, web, tray and agents (through MCP) are
  `/api/v1` clients. That holds in local and remote mode alike.

## Data model

### Skill and version

```ts
interface Skill {
  id: string;                 // slug, = SKILL.md `name`; unique per owner
  description: string;        // from SKILL.md frontmatter, for listings
  source: SkillSource;
  currentVersion: string;     // sha256 of the normalized tree
  agents?: string[];          // optional compatibility allowlist; absent = all
  userId: string | null;      // null until teams (Stage 2)
  createdAt: string;
}

type SkillSource =
  | { kind: 'upload' }                                         // web UI / CLI file upload
  | { kind: 'folder'; hostId: string; path: string; linked: boolean } // a PC folder
  | { kind: 'git'; url: string; path?: string; ref: string; commit: string }
  | { kind: 'marketplace'; marketplace: string; plugin: string; version?: string };

interface SkillVersion {
  skillId: string;
  sha256: string;             // of the normalized tree: sorted paths, modes, bytes
  files: { path: string; sha256: string; size: number; mode: number }[];
  size: number;
  provenance: { by: 'cli' | 'web' | 'sync'; hostId?: string; userId?: string; commit?: string };
  scan: SkillScan;            // see Security
  createdAt: string;
}
```

**Normalization.** Symlinks are resolved on the uploading host (reuse
`host-links.ts`). A link that won't resolve fails the import with its path
named, instead of being dropped. Dot-dirs that are machinery (`.system`,
`.cursor`) are skipped, as `filterSkillNames` already does. Modes are kept to
`0644`/`0755`. The tree hash is therefore identical for the same content from
any PC.

### Store: a `skills` custody scope

Per [owner direction](#owner-direction-2026-11-22) 1, the skill bytes live in
custody, next to the credentials and bake records the PC already seeds. A new
scope `skills` joins `CUSTODY_SCOPES`:

```
skills/<name>/meta.json            Skill (above) + version list, small
skills/<name>/<sha256>.tar.gz      one normalized tree per version, streamed put
```

Two to three segments, inside custody's 6-segment / `[A-Za-z0-9._-]` path
rule (a skill `name` is already lowercase-hyphen by the Agent Skills spec; one
that isn't is rejected at import). Tarballs go through the streaming put
(`putStream`, capped by `relay.custodyMaxBlobBytes`, 100 MiB default) that `cp`
already uses. Discard is custody's existing DELETE. Old versions are kept until
discarded or swept by a retention key.

Custody's admin-token gate applies to the library as a whole. A box never reads
custody directly: it gets only its own resolved set through the box-authenticated
`skills.get` RPC (see [Materialization](#materialization)), so putting
instructions next to logins in one store doesn't hand a box either.

Relational state that custody's key-value shape doesn't fit stays in the hub's
database (sqlite local, postgres on a control box):

| Table | Key | Holds |
| --- | --- | --- |
| `skill_bindings` | `(scope, scope_id, skill_id)` | `include` / `exclude`, optional pinned version |
| `box_skills` | `(box_id, skill_id)` | the version the box last materialized, ts |

`scope` is `global | workspace | project | box`. `project` is keyed by repo URL
(the box-sources repo key), not a host path, so a binding survives a second PC.

A per-skill cap (default **50 MB**, `skills.maxSkillBytes`) keeps a skill that
vendors `node_modules` out. Phase 0 found a real 23 MB skill, so the first
draft's 20 MB would have refused one of the owner's own.

## Getting a skill in

| Source | Command / surface | What happens |
|---|---|---|
| PC folder | `agentbox skills import [path…]` (default: `~/.agents/skills`, then each agent's declared skill dirs) | the CLI normalizes on the PC, uploads one tarball per skill to `POST /api/v1/skills/import` (the larger-body route custody uses). `--link` records a linked folder source: that PC's relay watches the folder and uploads a new version on change, which is the authoring loop. |
| git repo | `agentbox skills add <url>[#path][@ref]` (also `owner/repo`), web "Add from git" | the **hub** fetches (it already holds gh credentials; a box can't clone through the git shim) and records the commit. Layout-compatible with the open `skills` CLI (`skills/<name>/SKILL.md`, a repo with many skills offers a picker). |
| marketplace | `agentbox skills add --marketplace <m> --plugin <p>` | reads the plugin's `skills/` from a claude marketplace checkout (`known_marketplaces.json`) or codex `.tmp/marketplaces/`, and imports only the skills. Plugins as a whole keep riding the agent's config tree as today (see Decisions). |
| web UI | Skills page: upload a zip or folder, or create and edit `SKILL.md` in an editor | new version per save |
| a box | `agentbox download <agent>` today copies box-created skills to the host | becomes "propose to library": the pulled skill is offered as a new skill/version through the approvals flow, the same shape as the history plan's `memory_propose`. |

**First seed: automatic** (owner direction 2). When the hub's `skills/`
scope is empty, the PC seeds it with no prompt, at the first of:

- the end-of-setup step, `finalizeControlBoxState`, right after
  `syncAgentCredentials` and `syncBakesWithControlBox` (`hub setup`,
  `hub deploy <provider>`, the `hub expose` restart);
- the first `create` / `agentbox <agent>` against a hub with an empty library
  (covers a local hub, which has no setup step).

The seed takes every skill in `~/.agents/skills` and each agent's declared skill
dirs, de-duplicated by tree hash (the same skill reached through
`~/.claude/skills/x -> ~/.agents/skills/x` is one entry). It skips:
`agentbox-*`; Claude Code's own `skills/synced/` tree (claude.ai-managed skills,
which Claude Code re-syncs itself); and any skill the secret scan flags (see
[Security](#security)). The step prints one summary line with the counts and
the names of skipped skills. A flagged skill is uploaded only by an explicit
`agentbox skills` upload, after the user confirms the finding. Once the scope
is non-empty, the automatic seed never runs again, on any PC.

**After that: explicit.** A new skill on a PC reaches the hub only through the
`agentbox skills` TUI or its flags, `agentbox skills import`, `add`, or the web
UI. The hub is the source; a PC's folder is not watched unless linked with
`--link`.

### The `agentbox skills` TUI

Owner direction 3. A @clack/prompts flow (no new prompt library), run with no
arguments:

```
Skills         local (this PC)   hub (agentbox.example)  size    from        updated
unslop         ✓                 ✓ same                  12 KB   mac-marco   2026-11-20
daytona        ✓                 ✓ differs               2.3 MB  mac-marco   2026-10-02
frontend-...   ✓                 —                       24 KB
inngest        —                 ✓                       8 KB    linux-work  2026-11-21
```

- **Rows** are the union of this PC's skills (same discovery as the seed) and
  the hub's `skills/*/meta.json`, matched by name. The status column compares
  tree hashes: `same`, `differs` (local edits or a newer hub version, shown
  with which side is newer), local-only, hub-only. Size, source PC (the
  enrolled device name from multi-PC Phase 1b) and updated come from `meta.json`.
- **Actions** (a `multiselect` per action, then a `confirm` showing the totals):
  _Upload to hub_ (local-only or `differs` rows; secret-scan findings shown and
  confirmed per skill); _Download to this PC_ (hub-only or `differs` rows,
  written to `~/.agents/skills/<name>` and, for an agent that doesn't read
  `~/.agents`, linked from its own dir; an existing local skill that differs is
  overwritten only after a per-skill confirm); _Discard from hub_ (custody
  DELETE of the skill's whole prefix; boxes that pin it keep their
  materialized copy until their next sync).
- **Flags** for every action, for scripts and agents:
  `agentbox skills --list [--json]`, `--upload <name…>|--upload-all`,
  `--download <name…>|--download-all`, `--discard <name…>`, plus `--yes`
  to skip confirms and `--allow-findings` to upload a flagged skill without a
  prompt. Under a non-TTY without `--yes`, a destructive action refuses rather
  than guessing.

Download is how one PC is aligned with another: run it on PC B after PC A
uploaded, and PC B's host agents see the same set as every box.

## Getting a skill to a box

### Resolution

Most specific first, the same order as `<agent>.account` in the accounts plan:

1. `--skill <name>[@version]` / `--no-skill <name>` / `--no-skills` on
   `create` and `agentbox <agent>`
2. box bindings (edited later through the API)
3. project bindings (keyed by repo URL)
4. workspace bindings
5. global bindings, which is the default set. A freshly imported skill is
   global-included unless the user says otherwise.

Bindings are per user, kept on the hub. They are **not** read from the repo's
`agentbox.yaml`. A repo must not be able to pull arbitrary skills into your
boxes, and a repo's own skills already travel in `.claude/skills` /
`.agents/skills`. The agent's `agents` allowlist then filters the set per agent.

The resolved set is recorded on the box at create time
(`BoxRecord.skills: { id, version }[]`) and carried on the hub `Box` payload.
Every later step (update, display, clone) reads it from there.

### Materialization

At boot and on `skills.sync`, ctl calls a new relay RPC `skills.get` →
`{ set: [{ id, version, files[] }] }`, downloads the blobs it lacks
(`skills.blob`, content-addressed, so a checkpoint boot or a second box fetches
nothing new), and writes:

- one canonical tree: `/opt/agentbox/skills/library/<name>/…` (box-local, in
  the container layer or VM disk, never on a shared docker volume), plus a
  manifest of what it wrote;
- the agent's injection point, measured in Phase 0 and all box-local:

| Agent | Injection (measured) | Shape | Naming |
| --- | --- | --- | --- |
| claude | `/etc/claude-code/.claude/skills/<name>` → symlink per skill | `dir` | unprefixed (`/unslop`); `--plugin-dir` also works but prefixes every skill (`lib:unslop`), `--add-dir` works but also grants file access |
| codex | `/etc/codex/skills/<name>` → symlink per skill (codex's `admin` scope) | `dir` | unprefixed |
| opencode | `OPENCODE_CONFIG_CONTENT='{"skills":{"paths":["<dir>"]}}'` on the agent process | `env` | unprefixed |
| pi | `--skill <dir>` on the launch argv (accepts a dir of skills) | `flag` | `skill:<name>`, same as every pi skill |
| openclaw | `skills.load.extraDirs` += `<dir>`, merged the way `openclaw-agentbox-env` already merges `/opt/agentbox/skills` | `config` | unprefixed |

`/etc/claude-code` already exists in every base image (`Dockerfile.box` puts
`CLAUDE.md` there). `/etc` is root-owned, so ctl writes there through the same
root path the agent seeds use.

`AgentSyncSpec` gains a data-only block:

```ts
skills?: {
  /** Where this agent discovers user skills (display + host discovery for the TUI/seed). */
  dirs: string[];
  /** How the box-local library dir is handed to the agent. Every kind is per box. */
  inject:
    | { kind: 'dir'; path: string }                  // symlink each skill into an absolute box-local dir
    | { kind: 'flag'; argv: string[] }               // launch argv, {dir} substituted (pi)
    | { kind: 'env'; name: string; json: unknown }   // launch env, {dir} substituted (opencode)
    | { kind: 'config'; jsonPath: string[] };        // union into a config array (openclaw)
};
```

All five agents follow a symlinked skill directory (Phase 0), so `dir` injection
links into the canonical tree rather than copying.

ctl owns removal, using its manifest: an entry it wrote and the set no longer
contains is deleted. Anything it didn't write (the user's in-box skills,
`agentbox-*`, codex `.system`) is never touched. That fixes the "deletes never
propagate" bug without a blind `--delete`.

**Docker's shared volumes** were the risk: writing per-box skills into
`agentbox-claude-config` or `agentbox-agents-config` would leak them into every
box. Phase 0 settled it: every agent has a box-local injection point (table
above), so library skills never touch a shared volume. Once the library is on:

- **stop seeding `~/.agents` from the host.** That volume exists only to carry
  host skills, and the library replaces it;
- **exclude `skills/` from each agent's config-volume sync.** Otherwise a
  host-carried copy and the library copy of the same name coexist. Claude
  lists one entry (measured; which copy won was not determined without a
  turn), pi documents first-found-wins with a warning, and codex and opencode
  were not measured. Excluding the carried copy avoids depending on any of it.

**Cloud bakes** stop carrying the user's skills once the library is on: the
stager excludes `skills/` (and `~/.agents`) from `stageAllAgentStatic`, so a
base snapshot is no longer user-specific in this dimension, and the "silently
stale" bug goes away instead of needing a fingerprint. Until the library is on,
`stageAllAgentStatic` should at least fold a skills digest into the variant
fingerprint, so `prepare` reports the base as stale (Phase 1, a fix that stands
on its own).

**Fallback.** If the hub has no library, or the relay can't be reached at
boot, today's paths stay exactly as they are. ctl's `skills.get` returns
`{ library: false }` and ctl does nothing. Losing skills must never block a
box from booting.

Per the memory note on cloud RPCs: `skills.get` / `skills.blob` must be
served on both the relay's `/rpc` path in `server.ts` and the in-box forwarder
used by the cloud executor.

### Updates to running boxes

- A new version of a skill marks every box that has it as `behind` (the
  `box_skills` row vs the skill's current version).
- **Policy, per source** (config key `skills.update`):
  - `auto` for `folder` and `upload` sources, the user's own skills: the relay
    sends `skills.sync` to running boxes (docker: direct; cloud: via
    `CloudBoxPoller`). ctl re-pulls the files immediately. Whether a
    _running_ agent sees them differs (Phase 0): openclaw watches its skill
    dirs; codex caches its list per process and opencode loads config once, so
    both see the change at their next session; pi needs `/reload` or a new
    session; claude was not measured. The UI therefore says "applied, active
    from the agent's next session", not "live".
  - `manual` for `git` and `marketplace` sources, which are third-party: the
    update is fetched and diffed but not applied until the user approves it
    (web, tray, `agentbox skills update`).
- Paused or stopped boxes apply the update on resume. ctl runs `skills.get` at
  boot anyway.
- A checkpoint captures the materialized tree. Restoring it re-runs the pull,
  so the box gets its recorded set, not today's library state, unless the user
  updates it.
- `agentbox skills update <box>|--all` and the web/tray "Update skills" action
  move a box's pins to current.

## Relation to memory, MCP and teams

**Memory** (agent-history plan, Phase 4) and skills are both hub-owned agent
context, and they share the propose-through-approvals write path. (Skills
store in custody per the owner direction; memory's store is the history plan's
choice.) They differ in shape:

| | memory | skills |
|---|---|---|
| written by | the agent, continuously | a person, deliberately |
| keyed by | `(repo_url, agent, scope, path)` | `(user, skill)` |
| direction | bidirectional, last-writer-wins | hub → box; box → hub only by proposal |
| format | per agent, no translation | one canonical format, placed per agent |

Promoting a memory into a skill (e.g. "turn this project's learned
conventions into a skill") is a later feature, but because both live on the
hub it only needs an API call, not a new pipeline.

**MCP.** The history plan's `/api/mcp` (and the relay's box-scoped proxy) gains
`skills_list` and `skill_get`. That lets an agent discover a library skill that
isn't installed in its box without the library inflating every box's
context. Installing one into a running box still goes through
`skills_propose_install` → approval. An agent can't widen its own skill set
silently.

**Stage 2 (multi-user).** Every row carries `user_id` (null until teams, like
the history plan). A box receives only its owner's skills. A team library is a
later scope (`team_id` on `skills`, bindings by team), with admin-approved
publishing, because a team skill is instructions every teammate's agent will
follow. Device enrollment (multi-PC Phase 1b) already gives each PC an identity
for the `folder` source's `hostId`.

## Surfaces

### `/api/v1`

`GET /skills` (filters: q, source, agent, scope), `POST /skills/import`
(tarball), `POST /skills` (`{ git | marketplace }`), `GET /skills/{id}`,
`GET /skills/{id}/versions`, `GET /skills/{id}/versions/{sha}/files/{path}`,
`GET /skills/{id}/diff?from&to`, `PATCH /skills/{id}` (enable, agents,
update policy), `DELETE /skills/{id}`, `POST /skills/{id}/refresh` (git:
fetch new commit), `GET|PUT /skill-bindings?scope&scopeId`,
`POST /boxes/{id}/skills/sync`, `GET /skills/{id}/versions/{sha}/tarball`
(the TUI's download). Create gains `opts.skills: { include?, exclude?, none? }`.
`Box.skills: [{ id, version, behind }]`. New fields are optional. The routes
read and write the custody `skills/` scope; the CLI never talks to custody
directly for skills, so local and remote hubs behave the same.

### CLI

- `agentbox skills` — the TUI above, with `--list [--json]`, `--upload`,
  `--download`, `--discard` (+ `-all` forms, `--yes`, `--allow-findings`)
- `agentbox skills show <name>`, `import [path…] [--link]`,
  `add <url|--marketplace>`, `enable|disable <name> [--project|--workspace]`,
  `update [<box>|--all]`, `diff <name>`, `ls --box <b> [--behind]`
- `--skill` / `--no-skill` / `--no-skills` on `create` and `agentbox <agent>`
- `agentbox list` gets a skill count, `agentbox status <box>` a SKILLS section
  with `behind` markers.

### Web

First (owner direction 4, Phase 1b): a Skills page that **lists** stored skills
(name, description, size, source PC, updated, version count) and **discards**
them, a pure `/api/v1` client like the rest of the hub UI. The System page's
"Skills · this control box" section is replaced by the library summary, since
the VPS home it lists today isn't what boxes get.

Later (Phase 6): sources, versions, diff viewer, scan findings, editor, a
skills picker in the create modal, and a Skills tab on box detail with "Update".

### Tray (`../agentbox-tray`)

Decode `Box.skills`, show a "skills behind" badge on a row, and an "Update
skills" action. Update the tray's `CLAUDE.md` contract list in the same
change.

Public docs (`apps/web/content/docs/`) in the same change as each surface.

## Security

A skill is instructions an agent will follow, often with scripts it will run.
Adding a skill is close to adding code to every box.

- **The box is still the boundary.** A skill runs inside the box with the
  box's powers: no host access except through relay host actions, which keep
  their approvals. A skill never brings host-tool grants with it, and its
  `allowed-tools` frontmatter is passed through as-is, never elevated.
- **Provenance and pinning.** Every version records where it came from (PC +
  path, git commit, uploader) and is content-addressed. A box runs exactly the
  versions recorded on it.
- **No silent third-party updates.** git and marketplace skills update on
  approval only, with a diff (default `manual`). A force-pushed ref shows up as
  a new commit to approve, never as an in-place change.
- **Scan on import, results shown, nothing auto-blocked by heuristics alone:**
  - secrets: a content scanner (gitleaks-class rules) run on the **PC before
    upload**, so a key in someone's `~/.agents` skill never reaches a remote
    hub. The host-tools deny list (`CREDENTIAL_ARGV_PATTERNS`) matches argv,
    not file content, so it can't do this job. Phase 0 found 299 raw hits
    across this box's skill and plugin copies and **no real secret**: all were
    documentation placeholders (`YOUR_API_KEY`, `<YOUR_..._PRIVATE_KEY>`),
    40-hex git SHAs, or test fixtures. So the scanner suppresses those three
    shapes, and a remaining hit **skips** the skill during the automatic seed
    and asks for confirmation in the TUI. It doesn't hard-block: a hard block
    at that false-positive rate would make the automatic seed useless.
  - instructions to print credentials: the deny-list patterns run over skill
    text are a useful _flag_ (3 of this box's skills tell the agent to run
    `… auth token`-shaped commands). They're shown, never block.
  - executables and scripts listed. Binaries over a size threshold flagged.
  - out-of-tree symlinks are rejected at normalization (see Data model).
  - frontmatter checked: `name` matches the directory, `description` present.
- **Reserved names.** `agentbox-*` can't be imported. AgentBox's own skills
  keep their baked/seeded path.
- **Box auth.** `skills.get` / `skills.blob` are box-authenticated relay RPCs
  that return only that box's resolved set. A box can't enumerate the library
  (MCP `skills_list` is scoped and read-only, and install is an approval).
- **Teams:** owner-only by default. Publishing to a team library requires an
  admin, and every change is audit-logged.

## Phases

Each phase is one session, merged to `feat/hub-skills`. Keep
`docs/hub-skills-backlog.md` live from Phase 1.

### Phase 0 — measure (no product code)

Answer with evidence, recorded in this doc:

- **Discovery per agent** (claude, codex, opencode, pi, openclaw, in a box):
  which dirs each reads user skills from, whether it reads `~/.agents/skills`,
  whether it follows a symlinked skill dir, and whether it picks up a new or
  changed skill mid-session or only at session start.
- **Per-box injection without a shared volume**, per agent: a flag
  (claude `--plugin-dir` / `--add-dir`, pi and opencode equivalents), an env
  var, or a config key (openclaw `skills.load.extraDirs` is known to work).
  Record each one's naming effect (e.g. plugin-namespaced skill names).
- **Format compatibility:** take five real skills from this Mac and load each in
  every agent. Note frontmatter keys an agent rejects or ignores.
- **Sizes:** count and total bytes of `~/.agents`, `~/.claude/skills`, and the
  skills inside `plugins/cache` on this Mac. Largest single skill.
- **Secret scan:** run the deny list over those skills and count hits.

**Done:** a table per agent and a go/no-go on "canonical box-local tree +
per-agent injection" for docker. If any agent can only read from its shared
config volume, the fallback design (docker-wide union set for that agent)
gets written down here.

**Status: done 2026-11-22. Go.** See [Phase 0 results](#phase-0-results).

### Phase 1 — custody `skills` scope, first seed, `agentbox skills` TUI

The `skills` custody scope (`CUSTODY_SCOPES`, path rules, streaming put,
retention), normalization + tree hash, the `/api/v1/skills` routes over it
(list, import, tarball download, delete), PC-side secret scan with the three
false-positive suppressions, the automatic first seed in
`finalizeControlBoxState` and on first create against an empty library, and the
`agentbox skills` TUI with its flags (`--list --upload --download --discard
--yes --allow-findings`). Public docs for the command.

**Done:** on a `hub expose` hub with an empty library, `hub` setup seeds this
PC's skills with one summary line and skips a planted fake-key skill; a second
run seeds nothing; on a scratch-HOME "second PC", `agentbox skills --download-all`
reproduces the same tree hashes; `--discard` removes a skill from custody.

**Status: implemented 2026-11-22**, live-checked on a `hub expose` hub plus a
scratch-HOME second PC: the seed uploaded 14 skills and skipped the planted
fake-key one by name, a second seed uploaded nothing, `--download-all` on the
second PC reproduced all 14 tree hashes, and `--discard` removed a skill while
the library stayed marked seeded. Deviations from the text above: AgentBox's
`/agentbox` fork skill (bare name `agentbox`) is reserved alongside `agentbox-*`;
each PC also remembers the hubs it has seen seeded, so later creates skip the
check without a network call; a different, separate `~/.claude/skills/<name>`
copy is never deleted by a download, only reported.

### Phase 1b — web list + discard, stale-bake fingerprint

The hub Skills page (list, discard) and the System page swap (owner direction
4). Separately, fold a skills digest into the cloud variant fingerprint, so a
`prepare` reports a base as stale when the host's skills changed, and so the
control box stops adopting a PC bake whose skills differ from the library.

**Done:** a skill discarded in the web UI is gone from `agentbox skills --list`;
a cloud `prepare` reports stale after adding a host skill.

### Phase 2 — delivery to boxes (claude, all providers)

`AgentSyncSpec.skills` for claude (`dir` → `/etc/claude-code/.claude/skills`),
the `skills.get` / `skills.blob` RPCs (both relay paths, served from custody),
ctl materialization + manifest-based removal, resolution from global bindings +
create flags, `BoxRecord.skills`, host-copy fallback when the library is empty,
`skills/` and `~/.agents` excluded from static stages and config-volume syncs
when the library is on.

**Done:** a library skill is invocable by claude in a docker box, a hetzner box
and a remote-docker box created from a remote hub whose VPS has no skills;
removing it from the binding removes it from a new box; a docker box with
`--no-skill x` doesn't see `x` while a sibling does.

### Phase 3 — every agent

`skills` blocks for codex (`dir` → `/etc/codex/skills`), opencode (`env`
`OPENCODE_CONFIG_CONTENT`), pi (`flag` `--skill`) and openclaw (`config`
`skills.load.extraDirs`), measured in Phase 0, plus retiring the docker
`~/.agents` volume.

**Done:** one library skill invoked by each of the five agents, on docker and one
cloud provider.

### Phase 4 — bindings, workspaces, projects

`skill_bindings` at workspace / project (repo URL) / box scope,
`/skill-bindings` API, `enable|disable --project|--workspace`, create-modal picker.

**Done:** the same repo from two PCs on one remote hub gets the same set;
a workspace-scoped skill appears only in that workspace's boxes.

### Phase 5 — git + marketplace sources, updates

Hub-side git fetch and refresh, marketplace skill import, the `behind`
computation, `skills.sync` to running boxes (docker direct, cloud via
`CloudBoxPoller`), the per-source update policy, `agentbox skills update|diff`,
and linked-folder watching on the PC relay.

**Done:** editing a linked folder skill reaches a running cloud box without a
restart of the box; a git skill's new commit shows as `behind` and applies
only after approval.

### Phase 6 — web + tray

Skills page grows sources, editor, diff and scan findings (list + discard
shipped in 1b); box-detail tab; tray badge + action; public docs for everything
above.

**Done:** add a skill from a git URL in the web UI, see it in a new box, update
it from the tray.

### Phase 7 — box → library and MCP

"Propose to library" from `agentbox download <agent>` via approvals;
`skills_list` / `skill_get` / `skills_propose_install` on `/api/mcp` and the relay
proxy (depends on the history plan's Phase 6 MCP server existing).

**Done:** a skill written by an agent inside a box lands in the library after
one approval and appears in the next box.

Stage 2 (team libraries) is not a phase here. It follows the multi-user work
and only adds `team_id` scope plus admin publishing to this schema.

## Phase 0 results

Measured 2026-11-22 inside an AgentBox Hetzner box, in a throwaway
`node:24-bookworm` container on the box's DinD, with each agent installed from
npm: claude 2.1.330, codex 0.171.0, opencode 1.19.6, pi 0.73.1, openclaw
2026.11.6. Discovery was read from each agent's own model-free listing, so no
turn was spent on it:

| Agent | Listing used |
| --- | --- |
| claude | the `system/init` event of `claude -p --output-format stream-json --verbose` (`skills`, `slash_commands`), emitted before auth (`Not logged in`, cost 0) |
| codex | `codex app-server` JSON-RPC `skills/list` (`forceReload` for re-scans) |
| opencode | `opencode debug skill` |
| pi | `pi --mode rpc --offline` → `get_commands` |
| openclaw | `openclaw skills list --json` |

Probe skills were planted in every candidate dir, as a real dir and as a
symlinked dir pointing outside the tree, plus project-level dirs in the cwd.
Two logged-in turns were spent, one claude and one codex, to confirm an
injected skill is actually used and not just listed (below).

### Discovery

| Read? | claude | codex | opencode | pi | openclaw |
| --- | --- | --- | --- | --- | --- |
| `~/.agents/skills` | no | yes | yes | yes | yes |
| `~/.claude/skills` | yes | no | yes | no | no |
| own user dir | `~/.claude/skills` | `~/.codex/skills` | `~/.config/opencode/skills` | `~/.pi/agent/skills` | `~/.openclaw/skills` |
| project `.agents/skills` | no | yes | yes | yes | n/a (workspace is its own dir) |
| project `.claude/skills` | yes | no | yes | no | n/a |
| symlinked skill dir | followed | followed (reports the resolved path) | followed | followed | followed |
| new skill in a running process | not measured (needs an interactive session) | **no**: a skill added mid-process is absent from the cached list after 5 s and appears only with `forceReload` or a new process | no: its built-in `customize-opencode` skill states config and skills load once and need a restart | no: needs `/reload` (README) | yes: `skills.load.watch` filesystem watch (openclaw's config docs) |

Two consequences beyond the plan. **(a)** Today's docker carry already
cross-feeds: opencode boxes see every `~/.claude/skills` skill, and codex, pi
and openclaw boxes see every `~/.agents/skills` skill, whatever agent the
skill was written for. **(b)** No agent reads only a shared-volume path. Every
one has a box-local injection point (next table), so the docker fallback
("docker-wide union set") isn't needed.

### Per-box injection

| Agent | Mechanism | Result |
| --- | --- | --- |
| claude | `/etc/claude-code/.claude/skills/<name>` (managed dir, no flag) | loaded unprefixed with no flag; symlinked entries followed; the 5 real skills loaded. `/etc/claude-code/skills` (without `.claude`) is **not** read. |
| claude | `--add-dir <d>` (loads `<d>/.claude/skills`) | loaded unprefixed. Rejected as the default because it also widens file access to `<d>`. |
| claude | `--plugin-dir <d>` with `.claude-plugin/plugin.json` + `skills/` | loaded, but every skill becomes `<plugin>:<name>` (`lib:unslop`). Rejected. |
| codex | `/etc/codex/skills/<name>` | loaded as scope `admin`, unprefixed; symlinked entries followed; the 5 real skills loaded. (`skills/extraRoots/set` is an app-server API call; no TUI flag or config key for it was found.) |
| opencode | `OPENCODE_CONFIG_CONTENT='{"skills":{"paths":["<d>"]}}'` | loaded; the 5 real skills loaded. `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` drops `~/.claude`, `~/.agents` **and** the project's `.claude`/`.agents` skills, so it is not a usable way to exclude only carried copies. |
| pi | `--skill <d>` (a dir of skills or a single skill) | loaded; with `--no-skills --skill <d>`, only `<d>` loads. |
| openclaw | `openclaw config set skills.load.extraDirs '[...]'` | loaded as source `openclaw-extra`; openclaw reports "No gateway restart needed". |

**Use, not just listing.** claude: with a skill only in
`/etc/claude-code/.claude/skills`, `claude -p "Use the probe-managed1 skill…"`
replied with the word that skill's body instructs. codex: with a skill only in
`/etc/codex/skills`, `codex exec` read it from that path and replied with its
word. The run used `--dangerously-bypass-approvals-and-sandbox`, as boxes do;
codex's own bubblewrap sandbox couldn't start in the measuring container
(`No permissions to create a new namespace`). opencode, pi and openclaw were
verified at the listing level only.

### Format compatibility

Five real skills from this box's `~/.agents/skills` copy: `unslop` (1 file),
`frontend-design` (+ `LICENSE.txt`, frontmatter `license`), `copywriting`
(`references/`, frontmatter `version`), `agent-browser` (`templates/*.sh`,
`references/`, frontmatter `allowed-tools`), `screenshot` (scripts in
sh/py/swift/ps1, assets, an `agents/openai.yaml`, quoted frontmatter values).
**All five loaded in all five agents**, and no agent reported an error or
warning: codex's `errors` array was empty, pi logged nothing, and opencode listed all five (its stderr was not captured separately).
Unknown frontmatter keys are carried, not rejected. Nothing to translate per
agent.

### Sizes

The owner's Mac (measured by the coordinator): `~/.agents` 55 MB (18 skills
in `~/.agents/skills`), `~/.claude/skills` 8.9 MB (21 entries), 128 `SKILL.md`
under `~/.claude/plugins/cache`.

This box's copies (carried in from that Mac, so they show what a box actually
receives):

| Tree | Size | Skills |
| --- | --- | --- |
| `~/.agents` | 26 MB | 15 in `skills/` |
| `~/.claude/skills` | 35 MB | 16 + `synced/` (13 claude.ai-synced `SKILL.md`, 4.7 MB) |
| `~/.codex/skills` | 772 KB | 4 + `.system` |
| `~/.claude/plugins` | 27 MB | 86 `SKILL.md` |

- **Largest single skill:** `nano-banana-pro-prompts-recommend-skill`, 23 MB:
  three reference JSONs (10.8, 5.8 and 1.8 MB) and a 1.9 MB cover PNG. Next is
  `daytona` at 2.3 MB (176 files). Hence the 50 MB default cap.
- **The carry duplicates.** On the Mac, `~/.claude/skills` is 8.9 MB because its
  entries are symlinks into `~/.agents`. In the box it is 35 MB: the carry
  dereferences them (`rsync -L`), so every shared skill arrives twice, with no
  symlinks left. A tree-hash library ships each once.

### Secret scan

gitleaks v8.24.3 (`dir` mode) over this box's copies, triaged by hand:

| Tree | Raw hits | Rules | Real secrets |
| --- | --- | --- | --- |
| `~/.agents/skills` | 63 | curl-auth-header 53, generic-api-key 6, private-key 4 | 0: all in `daytona/references/**`, placeholders (`Bearer YOUR_API_KEY`, `<YOUR_OPENVPN_CLIENT_PRIVATE_KEY>`) |
| `~/.claude/skills` | 63 | same files (the dereferenced duplicates) | 0 |
| `~/.codex/skills` | 0 | — | 0 |
| `~/.claude/plugins` | 236 | sourcegraph-access-token 230, curl-auth-header 4, generic-api-key 2 | 0: the 230 are 40-hex git SHAs in marketplace JSON and `plugin-catalog-cache.json`; the 6 are vercel plugin test fixtures (`sk_live_abc123`) |

The host-tools deny list (`CREDENTIAL_ARGV_PATTERNS`, 12 patterns) matches
argv, not secrets in files. Run over skill text, it flags skills that _tell
the agent_ to print a credential: `agent-browser` and `daytona` in
`~/.agents/skills`, plus `agentbox-info` in `~/.claude/skills`, all on the
`auth token` pattern. That's useful as a shown flag, not a gate. The scan
design in [Security](#security) follows from these numbers.

### Go / no-go

**Go** on "canonical box-local tree + per-agent injection", for docker and
every other provider. All five agents load the library from a box-local path
that is never a shared volume: claude and codex by symlinks in a system dir,
opencode by an env var, pi by a flag, openclaw by a config key. One format
works everywhere, unchanged. The plan's injection table, the `inject` shape,
the 50 MB cap and the scan semantics have been updated to match.

## Decisions (defaults proposed, to confirm)

1. **Library authority:** the hub, stored in the custody `skills` scope
   (owner direction). The first seed from the PC is automatic; after that,
   adding a skill is always an explicit action. The creating host's copy is the
   fallback only while the library is empty.
2. **Default set:** every imported skill is global-included. Selection is
   mostly subtractive (`--no-skill`), matching how people use skills today:
   everything everywhere.
3. **Repo config can't select skills:** bindings live on the hub, per user,
   never in `agentbox.yaml`.
4. **Plugins:** out of the library in v1. Claude plugins and marketplaces keep
   riding `~/.claude` as today, and only a plugin's skills can be imported. A
   plugin library is a separate plan if it's wanted.
5. **Update policy:** `auto` for your own sources (folder, upload), `manual`
   for git and marketplace.
6. **Docker `~/.agents` volume:** retired once the library is on (Phase 3).
   Phase 0 found no agent that can read skills only from there.
7. **Size cap:** 50 MB per skill, configurable (`skills.maxSkillBytes`).
   Raised from 20 MB: the largest real skill measured is 23 MB.
8. **claude.ai-synced skills** (`~/.claude/skills/synced/<org>_<id>/…`, managed
   and re-synced by Claude Code itself) are not seeded or offered for upload.
   They keep riding the claude config tree.
9. **Secret-scan hits skip, they don't block:** a flagged skill is left out of
   the automatic seed and needs a confirm in the TUI.
10. **Download target:** `~/.agents/skills/<name>`, plus a link from
    `~/.claude/skills/<name>` for claude, the only measured agent that doesn't
    read `~/.agents/skills`.

## Open questions

- Should a linked folder (`--link`) be allowed on a PC other than the one that
  linked it, or does the hub refuse uploads for a folder source from another
  `hostId`?
- ~~Claude's plugin-dir namespacing~~: resolved by Phase 0. The managed dir
  `/etc/claude-code/.claude/skills` loads skills unprefixed.
- ~~Should a PC be fed from the library (`skills pull`)?~~: resolved yes by the
  owner direction, as the TUI's Download action.
- Does the automatic first seed run when the library was emptied by discarding
  everything? Proposed: no. The "seeded once" marker lives in custody
  (`skills/.seeded`), so an emptied library stays empty until an explicit upload.
- Claude's hot reload was not measured (it needs an interactive session). Worth
  one check in Phase 2, since claude is the most-used agent.
- Openclaw bots are long-lived. Should their skill updates default to `manual`
  regardless of source, since a bot changes behaviour with no one watching?
- How much of the open `skills` CLI ecosystem (`.skill-lock.json`, skills.sh
  directory) to interoperate with: read its lock to pre-fill git sources at
  import, or ignore it?

## Explicitly not doing

- Owning repo-committed project skills (git already delivers them).
- Translating skill content between agents. One format, placed per agent.
- Pushing files into boxes from the hub: boxes pull over the relay.
- Auto-applying third-party skill updates.
- A parallel box → hub channel: box traffic rides the relay.
