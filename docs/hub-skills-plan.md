# Skills in the hub — a hub-owned skills library

**Status:** plan, nothing implemented. Phase 0 (measurement) gates the
delivery design.

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

1. **Remote control box.** A hub-created box gets the skills in the *VPS's*
   home directory, usually none. The System page says so ("Skills · this
   control box", `apps/hub/lib/host-carried.ts`). Custody holds credentials
   but has no skills scope (`CUSTODY_SCOPES` = agents, projects, boxes,
   prepared).
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

### Store

sqlite on a local hub, postgres on a control box, same as the history plan.

| Table | Key | Holds |
|---|---|---|
| `skills` | `(user_id, id)` | metadata, source, current version |
| `skill_versions` | `(skill_id, sha256)` | file manifest, size, provenance, scan result |
| `skill_bindings` | `(scope, scope_id, skill_id)` | `include` / `exclude`, optional pinned version |
| `box_skills` | `(box_id, skill_id)` | the version the box last materialized, ts |

`scope` is `global | workspace | project | box`. `project` is keyed by repo URL
(the box-sources repo key), not a host path, so a binding survives a second PC.

### Blobs

Files are stored content-addressed (`skills/blobs/<sha256>`) in the same
blob-store seam the history plan introduces for transcripts. Skills are small,
so custody's small-payload store would also work. They don't go into custody
proper, though: custody is credential-shaped, and putting skills there would
put instructions next to logins under one access rule. A per-skill cap
(default 20 MB, config key) keeps a skill that vendors `node_modules` out.

## Getting a skill in

| Source | Command / surface | What happens |
|---|---|---|
| PC folder | `agentbox skills import [path…]` (default: `~/.agents/skills`, then each agent's declared skill dirs) | the CLI normalizes on the PC, uploads one tarball per skill to `POST /api/v1/skills/import` (the larger-body route custody uses). `--link` records a linked folder source: that PC's relay watches the folder and uploads a new version on change, which is the authoring loop. |
| git repo | `agentbox skills add <url>[#path][@ref]` (also `owner/repo`), web "Add from git" | the **hub** fetches (it already holds gh credentials; a box can't clone through the git shim) and records the commit. Layout-compatible with the open `skills` CLI (`skills/<name>/SKILL.md`, a repo with many skills offers a picker). |
| marketplace | `agentbox skills add --marketplace <m> --plugin <p>` | reads the plugin's `skills/` from a claude marketplace checkout (`known_marketplaces.json`) or codex `.tmp/marketplaces/`, and imports only the skills. Plugins as a whole keep riding the agent's config tree as today (see Decisions). |
| web UI | Skills page: upload a zip or folder, or create and edit `SKILL.md` in an editor | new version per save |
| a box | `agentbox download <agent>` today copies box-created skills to the host | becomes "propose to library": the pulled skill is offered as a new skill/version through the approvals flow, the same shape as the history plan's `memory_propose`. |

**First-run migration.** The first time a hub with an empty library sees a
create from a PC, the CLI offers once to import that PC's skills: a list with
checkboxes and a secret-scan warning per hit. Declining keeps the host-copy
fallback, so nothing changes for a user who never opts in.

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

- one canonical tree: `/home/vscode/.agentbox/skills/<name>/…` (box-local, so
  never on a shared docker volume), plus a manifest of what it wrote;
- for each agent in the box, the entries in that agent's declared skill
  location(s), as symlinks into the canonical tree, or a copy where the agent
  doesn't follow links (Phase 0).

`AgentSyncSpec` gains a data-only block:

```ts
skills?: {
  /** Where this agent discovers user skills, relative to its config root or absolute. */
  dirs: string[];
  /** How a per-box skill dir is handed to the agent without touching a shared volume. */
  inject?:
    | { kind: 'dir' }                                // write into dirs[0] (box-local only)
    | { kind: 'flag'; argv: string[] }               // e.g. a plugin-dir / add-dir flag, {dir} substituted
    | { kind: 'config'; jsonPath: string[]; file: string } // e.g. openclaw skills.load.extraDirs
  /** Follows symlinked skill dirs. */
  followsSymlinks: boolean;
};
```

ctl owns removal, using its manifest: an entry it wrote and the set no longer
contains is deleted. Anything it didn't write (the user's in-box skills,
`agentbox-*`, codex `.system`) is never touched. That fixes the "deletes never
propagate" bug without a blind `--delete`.

**Docker's shared volumes** are the hard part. Writing per-box skills into
`agentbox-claude-config` or `agentbox-agents-config` leaks them into every
box. Two candidate fixes, chosen per agent in Phase 0:

- **inject by flag/config** to a box-local dir (openclaw already does this with
  `extraDirs`; claude, codex, opencode and pi each need their mechanism
  measured);
- **stop seeding `~/.agents` from the host** once the library is on. That
  volume exists only to carry host skills, and the library replaces it. The
  per-agent config volumes keep everything else.

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
    `CloudBoxPoller`). ctl re-pulls and agents pick it up on their next session
    or reload (Phase 0 measures which agents hot-reload).
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
context, and they share the blob seam and the propose-through-approvals write
path. They differ in shape:

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
`POST /boxes/{id}/skills/sync`. Create gains `opts.skills: { include?, exclude?, none? }`.
`Box.skills: [{ id, version, behind }]`. New fields are optional.

### CLI

- `agentbox skills ls [--box <b>] [--behind]`, `show <name>`, `import [path…] [--link]`,
  `add <url|--marketplace>`, `rm`, `enable|disable <name> [--project|--workspace]`,
  `update [<box>|--all]`, `diff <name>`
- `--skill` / `--no-skill` / `--no-skills` on `create` and `agentbox <agent>`
- `agentbox list` gets a skill count, `agentbox status <box>` a SKILLS section
  with `behind` markers.

### Web

A Skills page (library, sources, versions, diff viewer, scan findings, editor),
a skills picker in the create modal, a Skills tab on box detail with "Update",
and on the System page the "Skills · this control box" section is replaced by
the library summary.

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
  - secrets: the host-tools credential deny list plus high-entropy patterns,
    run on the **PC before upload** so a key in someone's `~/.agents` skill
    never reaches a remote hub. A hit blocks the upload unless the user
    explicitly accepts it.
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

### Phase 1 — library store + import (no delivery)

Schema, blob store, normalization + tree hash, `POST /skills/import`,
`agentbox skills import|ls|show|rm`, PC-side secret scan. Separately, fold a
skills digest into cloud variant fingerprints so a stale bake is reported.

**Done:** `~/.agents/skills` from this Mac imported into a local hub and into a
`hub expose` hub, with identical tree hashes; a cloud `prepare` reports stale
after adding a host skill.

### Phase 2 — delivery to boxes (claude, all providers)

`AgentSyncSpec.skills` for claude, the `skills.get` / `skills.blob` RPCs
(both relay paths), ctl materialization + manifest-based removal, resolution
from global bindings + create flags, `BoxRecord.skills`, host-copy fallback
when the library is empty, `skills/` and `~/.agents` excluded from static
stages when the library is on.

**Done:** a library skill is invocable by claude in a docker box, a hetzner box
and a remote-docker box created from a remote hub whose VPS has no skills;
removing it from the binding removes it from a new box; a docker box with
`--no-skill x` doesn't see `x` while a sibling does.

### Phase 3 — every agent

`skills` blocks for codex, opencode, pi and openclaw per Phase 0, plus the
docker `~/.agents` volume retirement (or its documented fallback).

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

Skills page with editor, diff and scan findings, box-detail tab, System page
swap; tray badge + action; public docs for everything above.

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

## Decisions (defaults proposed, to confirm)

1. **Library authority:** the hub, with the creating host's copy as fallback
   only while the library is empty. The library turns on at the first
   import. There's no separate switch.
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
6. **Docker `~/.agents` volume:** retired once the library is on (Phase 3),
   unless Phase 0 shows an agent that can only read skills from there.
7. **Size cap:** 20 MB per skill, configurable (`skills.maxSkillBytes`).

## Open questions

- Should a linked folder (`--link`) be allowed on a PC other than the one that
  linked it, or does the hub refuse uploads for a folder source from another
  `hostId`?
- Claude's plugin-dir injection, if it's the docker mechanism, namespaces skill
  names (`plugin:skill`). Is that acceptable for the `/skill` invocation users
  type, or does claude need the box-local `~/.claude` overlay approach instead?
- Should host sessions (not boxes) also be fed from the library, i.e. an
  `agentbox skills pull` that writes the library into `~/.agents`, making the hub
  the source of truth for the PC too? Proposed: yes, opt-in, later.
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
