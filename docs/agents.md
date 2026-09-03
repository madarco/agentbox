# Agents

How a coding agent gets into a box, and why a box carries only one.

This is the steady-state reference — the shape the agent layer has today. What
is still outstanding lives in
[`agents-remaining-work.md`](./agents-remaining-work.md).

---

## Thesis: an agent is a row of data

An agent used to be a `RUN npm install -g …` line in `Dockerfile.box`, mirrored
into four cloud provision scripts, plus a hand-written `ensure<Agent>Installed`
per tool. Adding one meant editing all of them and keeping them in step.

Now each agent is one entry in **`AGENT_SYNC_SPECS`**
(`packages/sandbox-core/src/sync/registry.ts`), and that entry carries an
`install` recipe alongside the sync/credential data it already had:

```ts
{
  id: 'codex',
  binary: 'codex',                       // probe: `command -v codex`
  install: {
    recipe: { kind: 'npm', package: '@openai/codex' },
    runAs: 'root',
    apt: ['bubblewrap'],
    postInstall: '…dirs, symlinks, ownership…',
  },
  // …sessionName, dockerVolume, staticPaths, credential, caps
}
```

**One recipe, two execution sites** (three once the cloud half lands):

| site | what runs it | when |
|---|---|---|
| derived image layer | `buildDerivedAgentImage` (`sandbox-docker/src/image.ts`) | `agentbox <agent>` on docker |
| live box | `ensureAgentInstalled` (`sandbox-core/src/sync/concerns/install.ts`) | adding an agent to a running box |
| cloud derived snapshot | each provider's `prepare` (`--agents <set>`) | baking an agent onto a cloud base |

Keep the sites in step by keeping the *data* in one place — never by copying an
install into a second file. Every site above renders the same
`AGENT_SYNC_SPECS.install` entry, so a baked agent and a runtime-added one are
byte-identical in layout; no provision script installs an agent any more.

### Recipe fields that matter

- **`runAs`** is not a detail. Claude's native installer writes into the
  *invoking* user's `~/.local/bin`, so running it as root puts `claude` in
  `/root` and the box user never sees it. `npm install -g` is the opposite and
  needs root.
- **`postInstall`** owns the agent's home + credential dirs (`~/.claude`,
  `~/.codex`, `~/.agentbox-creds/<agent>/` and the symlinks that pivot each
  agent's credential path into a mounted volume). It lives here, not in the
  Dockerfile, so every install site produces the same layout. Use
  `agentDirPrelude()` for the first two steps rather than writing them by hand:
  **`~/.agentbox-creds` is a MOUNT at runtime, not a directory the recipe owns.**
  On Daytona it is virtiofs — `drwxrwxrwx root root`, and `chown`/`chmod` there
  return EPERM *even for root*. A recipe that folds it into `install -d -o
  vscode` works at bake time, when nothing is mounted yet, and fails every
  runtime install. The helper does `install -d` for the agent's own dirs,
  `mkdir -p` for its subdir of the mount, and a best-effort chown of the mount.
- **`alternates`** are other ways to install the same agent, keyed by the value
  of the setting named in `alternatesFrom`. Only claude declares one:
  `claude.install: npm` is the escape hatch for hosts whose egress IP the Claude
  CDN 403s. See "Agent settings" below.
- **`script` recipes fetch to a file and run it with `bash`.** Not `curl | bash`
  — piping hides a blocked download behind bash's exit 0 — and not `sh`, because
  `/bin/sh` is dash on Debian/Ubuntu and these installers are bash scripts.

---

## Agent settings

Some things about an agent are genuinely that agent's own. Which installer Claude
Code uses (`native` vs the npm package) and which of its two renderers it pins
are facts about Claude, not about agents in general — so they stay CLAUDE-named.
What generalises is the **mechanism**.

An agent declares its settings on its row:

```ts
settings: [
  {
    key: 'install',                       // -> the `claude.install` config key
    type: 'enum',
    enumValues: ['native', 'npm'],
    default: 'native',
    description: '…',
    affectsBake: true,                    // folds into variantFingerprint
  },
],
install: { …, alternatesFrom: 'install', alternates: { npm: { … } } },
tuiEnvFrom: 'tui',
```

Three consumers, and only the first two are things AgentBox itself knows how to
do with a setting:

| declaration | what reads it |
|---|---|
| `install.alternatesFrom` | `resolveAgentInstall` picks the alternate recipe |
| `tuiEnvFrom` | `agentTuiEnv` picks the launch env |
| *(everything)* | `renderAgentSettingEnv` exports `AGENTBOX_AGENT_SETTING_<UPPER_SNAKE_KEY>` into the agent's own `recipe` and `postInstall` |

The third is the point. An agent installed from an npm package can put arbitrary
logic in its `postInstall` and read its own settings there, so a setting nothing
in this repo was written to understand still reaches the bake — on every
provider, including a community one, because the env is rendered by the shared
install path rather than by any provider's script.

**Both bindings are named explicitly** rather than by a reserved key. That is
what lets `agent-settings-drift.test.ts` assert the named setting exists, is an
enum, and covers every key of the map it selects — a convention could not be
checked, and an `alternates` map nothing selects is silently dead code.

### Where the config keys come from

`@agentbox/config` is a zero-internal-dep leaf, so it cannot read the registry.
The settings are mirrored into `AGENT_KINDS` (`packages/config/src/agents.ts`)
as data and drift-tested from `apps/cli`, the same copy-not-import arrangement
`PROVIDERS` uses. `perAgentKeys()` generates `<agent>.<key>` from that, and the
agent blocks on `UserConfig`/`EffectiveConfig` carry an index signature — so
adding a setting needs **no** hand edit to a TypeScript interface, unlike
`sessionName`.

**A plugin agent's settings are real config keys too.** `AgentSyncSpec.settings`
is pure JSON, so it survives `agentbox agent add`'s snapshot into
`~/.agentbox/agents.json`; `KEY_REGISTRY` is `BUILTIN_KEY_REGISTRY` plus whatever
that file declares, resolved once at module load exactly like `AGENT_SPECS`. The
JSON schema is generated from the built-ins only — it ships with the package and
must describe what this BUILD knows, not one machine's install set.

### Reading them

Host-side, always through the accessor (`@agentbox/config`):

```ts
agentSettings(cfg, 'claude')          // one agent's block, defaults applied
allAgentSettings(cfg)                 // every agent's — the prepare/create payload
agentSettingsFor('claude', workspace) // from disk; never throws
```

`agentSettingsFor` reads the BOX's workspace, not `process.cwd()`: the queue
worker runs from the state dir and `agentbox config set` writes `--project` by
default. It also swallows every failure — a renderer preference must not be able
to stop a session starting.

At the CLI, `--agent-setting <agent>.<key>=<value>` (repeatable) overrides one
setting for a bake. One generic flag rather than one per setting, because which
settings exist is a runtime fact; validation is against the declaration, so a
typo still fails loudly and an enum still lists its values.

### The root-escalation trap

`asRootScript` passes the script as a **positional parameter**
(`sh -c 'if [ "$(id -u)" = 0 ]; then sh -c "$1"; else sudo -n sh -c "$1"; fi' _ "<script>"`),
never interpolated into a quoted string. It used to embed it, which made the two
branches expand at different times: everything `$`-shaped in the sudo branch —
`$(command -v claude)`, and any variable the script's own prefix exported — was
substituted by the OUTER shell, as the box user, before sudo ran. A `postInstall`
reading its own setting therefore saw it empty on every cloud provider and
correct on docker.

---

## Moving an agent's files: one implementation, two directions

**Push** (host -> box) and **pull** (box -> host) each used to have two
implementations per agent — a `SyncTransport` one for cloud and a hand-rolled
`docker run -v` one for docker — and they had drifted in both directions.

`SyncTransport` has two docker modes now, sharing one body:

| mode | reaches the box by | used for |
|---|---|---|
| container | `docker exec` / `docker cp` | a running box |
| volume | a throwaway helper with the config volume mounted **at its box path** | a stopped box (the pull) |

Mounting at the box path is the load-bearing detail: a caller passes
box-absolute paths and neither mode rewrites them, which is what lets one body
serve both. Take the path from the registry (`staticPaths[0].boxDir`), never a
literal.

Two things the modes must differ on, both found by round-tripping a real volume
rather than by reading:

- **Who extracts.** A helper container's volume dirs are root-owned, so a
  `--user 1000` tar extract fails outright. Volume mode extracts as root and
  chowns after, exactly as the hand-rolled containers did.
- **AppleDouble sidecars.** macOS `tar` writes a `._name` file per entry unless
  `COPYFILE_DISABLE=1` is set; they land in the box as garbage and made a
  one-entry push fail.

### Excludes are one list per agent

`agentPushExcludes(spec, path, target)` renders both transports' `--exclude`
flags from `staticPaths[].exclude`. Two entries are DERIVED, and that is what
makes a single list safe for both:

- **The credential file**, from `credential.boxRelPath`. Out of a `'snapshot'`
  (shared by every box made from it); INTO a `'volume'`, which is that box's own
  login store. All three agents listed it and all three meant the same thing.
  An agent that declares no `credential` contributes no such entry — there is no
  file to keep out of a shared snapshot.
- **`LIVE_DATABASE_EXCLUDES`** (`*.sqlite*`, `*.db`, `*.db-*`), for every agent,
  with an `allowDatabases` opt-out nothing declares. Hand-enumerating these is
  what went stale: codex's list named `state_*` and `logs_*`, and three later
  databases shipped live into every box.

Claude's docker volume is deliberately NOT converged on its spec list: those
excludes are snapshot hygiene and include ~20 entries the volume wants,
`.credentials.json` above all. It gets the database deny only.

---

## One agent per box

`agentbox claude` produces a box containing **claude and nothing else** — its
binary, its config volume, its credentials, its home dir. No codex or opencode
login is anywhere in that box.

`createBox({ agents })` is the authoritative selection. Omitted, it falls back to
the historical behaviour (mount whatever the host happens to have) so an
un-migrated caller keeps working.

| | |
|---|---|
| `agentbox claude` | `agents: ['claude']` |
| `agentbox codex` / `opencode` | likewise |
| a queued `-i` job | `[toSyncKind(job.agent)]`, or `[]` for `--no-agent` |
| `agentbox create` | `[]` — no agent |

The shared `~/.agents` skills volume is still mounted for every box: it is
agent-neutral and carries no auth.

### Which volume is whose

`BoxRecord.agentConfigVolumes` is a map keyed by agent id, read through
`agentConfigVolume(box, agent)` — which falls back to the three legacy
`<agent>ConfigVolume` fields for a box recorded before the map, and returns
`undefined` for an agent the box has none for.

Everything goes through that accessor: the propagate/credential fan-out targets,
`destroy`'s volume cleanup and `prune`'s keep-set. They were five hardcoded
tables whose `default:` arm returned **opencode's** volume, so a fourth or plugin
agent's credentials fanned into opencode's store — and `create` had the right map
all along, then narrowed it to three consts and discarded the rest.

`isolateFor` reads a generic `agentConfig` create option, so
`box.isolate<Agent>Config` — generated for every agent in `AGENT_KINDS` and inert
until now — actually works. `prune` had to move in the same change: an isolated
volume missing from its keep-set is deleted as an orphan while the box is alive.

`agentsConfigVolume` is not in the map — it is the shared `~/.agents` skills
volume, not an agent's.

---

## Image tiers

```
Dockerfile.box ──prepare/pull──▶ agentless base            agentbox/box:dev
                                        │
                                        ▼ FROM + install recipe
                                   agent layer             agentbox/box:dev-claude
                                        │
                                        ▼ docker commit
                                 project checkpoint        agentbox-ckpt-<hash>:<name>
```

The base carries **no agents**. Each agent is added as a thin `FROM <base>`
layer, not a second full build, because the agent installs would otherwise have
to sit above Playwright, Chromium and the VNC stack — so every one of those
layers would diverge per agent:

| | full variant build | derived layer |
|---|---|---|
| `dev-claude` unique | 1.279 GB | **434 MB** |
| `dev-codex` unique | 1.518 GB | **702 MB** |
| base | 2.23 GB shared | **3.07 GB, fully shared** |

It also means CI publishes **one** image rather than one per agent set.

Timings on a warm layer cache: base 56s, `+claude` 23s, `+codex` 21s, repeat
`claude` 0s.

### Fingerprints and prepared records

- `variantFingerprint(baseSha, { agents, agentSettings })` folds the build
  variant into the image identity. **The empty variant is the identity fold** —
  no agents, every setting at its declared default — so the plain base keeps the
  raw context hash and a provider that passes no variant is unaffected. Only
  settings declared `affectsBake` fold, and only when they differ from their
  default; without that second filter, declaring a setting on any agent would
  invalidate every existing artifact on every provider.
- **The agentless base folds nothing.** It installs no agent, so no agent setting
  can change what it contains: `evaluateDockerBaseFreshness`,
  `Provider.baseFingerprint` and each provider's `current<P>BaseFingerprintLive`
  all take no arguments and answer with the raw context hash. This was learned
  the expensive way — the base used to fork on the Claude install mode via a
  `Dockerfile.box` ARG that no `RUN` ever read, so CI published two
  byte-identical images under two tags, daytona rewrote a Dockerfile line that
  did nothing, and every freshness/adoption path had to try both hashes.
- `variantImageRef` gives each set its own local tag (`…:dev-claude`), so two
  boxes built for different agents can't overwrite one another's image.
- `docker-prepared.json` keeps **one record per variant**. It also stamps `base`
  with the most recently prepared image for `prepare --status` and custody, so
  **read `preparedShaFor(state, variant)`, never `state.base` directly** — after
  any agent bake `base` holds a *variant* hash, and comparing the agentless
  fingerprint against it reports a spurious `stale`.

---

## Adding an agent to a running box

Point a second agent at an existing box (`agentbox codex <claude-box>`, or the
dashboard's agent switch) and it is installed on demand.

The binary install is the easy half. The subtle half is credentials: **docker
fixes a container's mounts at `docker run`**, so the new agent's config volume
can never be attached to a box that is already running. Syncing the host-side
volume would write somewhere the box cannot see and leave the agent
unauthenticated with no visible error.

So `ensureAgentInstalled` pushes the credential **as a file** over the
`SyncTransport` (`pushCredentialToBox`), preferring the `~/.agentbox` backup —
the fan-out's newest-wins copy — over the tool's real path, and shape-validating
so a half-written file counts as absent. This is not a workaround: it is what
every cloud provider already does on each create (`TransportCaps.ephemeralFs`),
and the credential watcher plus `extractAgentCredentials` still carry any
resulting login back to the host.

Because it runs over `SyncTransport` rather than `docker exec`, this is also the
first time a **cloud** box booted from a snapshot that predates an agent can get
that agent at all.

### Root escalation across seams

Docker honours `exec --user root`; cloud backends run as the box user by name and
generally ignore it. One argv covers both:

```sh
sh -c 'if [ "$(id -u)" = 0 ]; then sh -c "$1"; else sudo -n sh -c "$1"; fi' _ "<cmd>"
```

`sudo -n` never prompts, so a box without a sudo grant fails fast with a usable
message instead of blocking on a password read nothing will answer. The command
rides as `$1` rather than being interpolated — see "The root-escalation trap"
above for what interpolating it silently broke.

---

## Two surfaces: TUI agents and service agents

`caps.surface` on the registry row says what an agent IS, and it is DECLARED,
never derived from the id:

- **`tui`** (the default when absent) — claude, codex, opencode, pi. An
  interactive tool the user attaches to: a tmux session, a wrapped pty,
  `attach` / `start` / `login`, session resume and teleport.
- **`service`** — openclaw. A daemon the box HOSTS. It has no session to attach
  to; ctl's supervisor runs it, its state is read from the supervisor rather
  than a tmux probe, and its CLI command ends at "service ready + URL printed".

Everything that behaves differently for a daemon reads that one field, so a
second service agent needs no new branch anywhere. What a service agent
declares instead of the TUI machinery:

- **`service: AgentServiceSpec`** — the ctl units that run it, mirroring ctl's
  own `ServiceSpec`/`TaskSpec` field-for-field: `command`, `restart`,
  `readyWhen`, `expose: { port, as: 80 }`, `needs`, and one-shot `tasks` (an
  onboard, a config render). They ride the `agents.list` RPC into the box and
  the supervisor folds them in through its normal reload diff — which is what
  lets a box booted from a snapshot baked before the agent existed still run it.
  A unit of the same name in `/workspace/agentbox.yaml` **wins**.
- **`service.urlFields`** — values `<agent> url` prints beside the URL, read out
  of the daemon's own config file (a Control UI's gateway token). Data, because
  the only per-agent parts are which file and which dotted key.
- **`configRender: AgentConfigRenderSpec`** — the layered-config descriptor
  `agentbox-ctl agent render <id>` drives; independent of `service`, since a TUI
  agent could want it too. See "Layered config" below.

What it does NOT get, and must not be given: an entry in the CLI's
`AGENT_MODULES` table (`AgentModule` is `AgentRuntime` + a login detector + a
teleport resolver, and a daemon satisfies none of the three — `startSession` has
to make a tmux session), an `attachWrapped`, or a `box.isolate<Agent>Config`
config key. That last one is not an omission: a service agent's config volume is
ALWAYS per-box, because two daemons sharing a state dir share one identity, so
`create` derives isolation from `caps.surface` and a key that could be set to
`false` would be one the product ignores.

Its CLI command is built by the shared factory
(`apps/cli/src/agents/command/service-factory.ts`) straight off the registry row
— there is nothing tool-specific to write — so adding a service agent is adding
a registry row plus the docker half of its package (which volume, mounted where,
and "no tmux session"). `packages/agent-openclaw` is that package, and it is
smaller than any TUI agent's.

The split is asserted, not documented: `agent-caps-wiring.test.ts` requires a
service agent to declare `service` and to declare `resume: false` /
`teleport: 'stub'`, and forbids a TUI agent from declaring `service`;
`agent-command-coverage.test.ts` asserts a service agent has a command and NO
attach wrapper; `agent-module-table.test.ts` asserts it has no CLI module.

### Layered config (`configRender`)

For an agent whose config file AgentBox owns a LAYER of: the tool underneath
gets updated, its factory defaults gain keys, and the user has hand-edited the
file in the box. A plain regenerate loses their edits; never regenerating means
they never get the new defaults.

**The merge is the tool's job.** `applyCmd` is a command the tool already ships
that takes a patch on stdin and merges it into its own file, validating as it
goes (`openclaw config patch --stdin`). Delegating buys three things a
hand-rolled merge cannot: no format parser, no shadow copy of the file, and a
render that keeps working across the tool's own config migrations — which is the
entire point. An agent whose tool has no such command simply does not declare
`configRender`.

AgentBox keeps only the small half: WHICH keys it is asserting this time.
`agentbox-ctl agent render <id>` reads the `agentbox.yaml` `<overlayKey>:` block,
diffs it against `~/.<agent>/.agentbox-overlay.json` (the overlay as last applied
AND validated), and sends only what changed — so a key the user edited in-box is
never re-asserted unless they edited the overlay too. It dry-runs first, gates on
`validate`, and records the overlay only once both halves passed.

Secrets never belong in the overlay: `agentbox.yaml` is committed. Real values
ride a `carry:` entry into a 0600 env file and the overlay references them by
name; the render lints for a secret-shaped literal and warns.

## Adding a new agent

1. **Add the row** to `AGENT_SYNC_SPECS`: `id`, `binary`, `install`
   (recipe + `runAs` + any OS `packages` (+ `packagesOptional`) +
   `postInstall`), `sessionName`,
   `dockerVolume`, `staticPaths`, `forwardedEnvKeys`, `caps`,
   plus `seeds` / `launchFlags` if the agent needs an agentbox-owned file in
   place to work (see step 4), and `settings` (+ `install.alternatesFrom` /
   `tuiEnvFrom`) for anything the user should be able to configure per agent
   (see "Agent settings").
   Keep it JSON-serializable — no closures — so the descriptor can later be
   shipped into a box whose `agentbox-ctl` was baked before the agent existed,
   and so `agentbox agent add` can snapshot it verbatim.

   **`credential` is optional.** Declare it when the agent has a login the HOST
   holds and AgentBox moves into the box — claude's OAuth blob, codex's
   `auth.json`. Omit it when the agent authenticates entirely inside the box, as
   openclaw does: its gateway token is generated per box by `openclaw onboard`,
   so there is nothing on the host to back up or push. Omitting is the only
   correct way to say that. The credential watch is FANOUT — whatever the field
   names is copied into every other box — so pointing it at the agent's real
   config would hand every box the first box's identity, and naming a file
   nothing ever writes adds a fiction every consumer has to know about. With the
   field absent the agent gets no credentials-volume mount, no `agents.list`
   credential watch, no host-backup probe and no entry in the relay fan-out;
   everything else about it is unchanged. Absent is not a placeholder for "not
   wired up yet" — if the agent has a host-side login, declare it.
2. **Add the agent's package** — `packages/agent-<id>/`, with its CLI surface
   under `src/cli/` — and its arm in the `AGENT_MODULES` table
   (`apps/cli/src/agents/index.ts`): the guided-login detector, and a
   session-teleport resolver if the agent declares `caps.teleport: 'full'`. Keep
   the `import()` specifier LITERAL; a computed one is not bundled and
   `MODULE_NOT_FOUND`s in the published CLI only.
   *No identity union to open* — `AgentId` is an open `string`, so step 1 is what
   makes the agent real to every consumer that reads the registry.
3. **Add the CLI command** — a descriptor, not a clone. In the package's
   `src/cli/`: `runtime.ts` (the docker bindings and the agent's own login code)
   and `cli-spec.ts` (an `AgentCliSpec` with the help strings that are genuinely
   yours). The app side is a ~15-line shim at `apps/cli/src/agents/<id>/command.ts`
   that hands your spec to `buildAgentCommand`, plus one arm in
   `apps/cli/src/agents/commands.ts`. The shim exists only because the two
   dispatch tables need literal, statically-resolvable specifiers — the factory's
   closure is the whole create/attach pipeline, which does not belong in a package.
   If a hook of yours needs something the APP owns (the setup wizard, a re-bake,
   the host clipboard), take it from `ctx.host` / the `clipboard` argument rather
   than importing it: a package that imports `apps/cli` closes a cycle.
   `index.ts`, `attach.ts`,
   `agent-sessions.ts`, `fork.ts` and `argv-prefix.ts` all read the tables, so
   there is nothing to register in any of them.
   *Nothing per-agent left in `list.ts`:* it iterates the box's agent status map,
   so a new agent shows up in the AGENT column and the cmux dock with no edit
   there.
4. **Seeded files**, if the agent loads an agentbox-owned hook/plugin/skill:
   declare `seeds: [{ bakedPath, destRel, sharedAsset, label }]` on the row, and
   `launchFlags` for any argv the agent needs to load them. Then add the file to
   `Dockerfile.box` (a `COPY` to `bakedPath`) and to `sharedFiles` in
   `apps/cli/scripts/stage-runtime.mjs` (the host copy the cloud path uploads
   when a base snapshot predates the asset). Both are asserted — a declared seed
   missing from either fails `packages/sandbox-core/test/agent-seed.test.ts`.
   There is no per-agent seeding CODE to write: docker seeds into the config
   volume and the cloud path seeds into the live box, both from this one row.
5. **Config keys**: one row in `AGENT_KINDS` (`packages/config/src/agents.ts`),
   carrying `settings` if the agent declares any (see "Agent settings").
   `<agent>.sessionName`, `<agent>.dangerouslySkipPermissions` (only where the
   agent has such a flag), `<agent>.<setting>` and `box.isolate<Agent>Config` are
   all GENERATED from it — key descriptor, default and all — the way
   `perProviderImageKeys()` generates the per-provider image keys. The row exists
   because `@agentbox/config` is a zero-internal-dep leaf (`sandbox-core` depends
   on *it*), so it cannot read `AGENT_SYNC_SPECS`; it is the same copy-not-import
   arrangement `PROVIDERS` uses, and it is drift-tested against the registry from
   `apps/cli`, which can see both. One hand edit remains and cannot be generated:
   the branch in `packages/config/schema/user-config.schema.json`, which is
   `additionalProperties: false` — caught by the config suite rather than left to
   discover. (The `UserConfig` / `EffectiveConfig` block used to be a second: the
   agent blocks now carry an index signature, so a declared setting needs no
   interface edit.) The command descriptor reaches the keys through typed
   accessors (`sessionNameOf`, `isolateOf`, `cliOverrides`).
6. **Activity reporting**, if the agent should report one: declare
   `caps.activitySource` — a list of `hooks` / `plugin` / `scraper`, empty if it
   reports nothing (ctl then skips probing it rather than adding a permanently
   `unknown` entry to every snapshot). *There is no ctl code to write:* status is
   a keyed map, one `agent-state <agent> <state>` op serves every agent, and the
   tmux session to probe ships from the host over the `agents.list` descriptor —
   so an agent added after an image was baked reports activity with no re-bake.
   Two things are enforced rather than documented: declaring `plugin` requires
   the `seeds` that put the plugin in the box, and a `WATCHED_CREDENTIALS` entry
   must match the registry (drift tests in `packages/sandbox-core` and
   `packages/ctl`).
   *Do not repoint the seeded hook files at `agent-state`.* ctl still ships the
   frozen `<agent>-state` names for the built-in three, because agent config
   volumes are SHARED BETWEEN BOXES: a `hooks.json` seeded by a newer image can
   be read by a box running older baked ctl, and that box would silently stop
   reporting.
6b. **If the agent is a SERVICE**, steps 2, 3 and 6 collapse: declare
   `caps.surface: 'service'` plus a `service` block (and `configRender` if its
   tool ships a patch command), skip the `AGENT_MODULES` arm and the `src/cli/`
   tree entirely, and add `surface: 'service'` to its `AGENT_KINDS` row so no
   `box.isolate<Agent>Config` key is generated. The CLI command comes from
   `buildServiceAgentCommand` off the registry row. What remains is the docker
   half of its package: `resolveVolume` / `buildMounts` / `ensureVolume`, and a
   `sessionInfo` that reports no session rather than probing tmux.
   `packages/agent-openclaw` is the worked example.
7. **`agentbox download <agent>`** — the box-to-host direction. A CLI command
   (`apps/cli/src/commands/download-<agent>.ts`) plus the pull functions and
   box-path constants in `packages/sandbox-core/src/sync/agent-pull.ts`. Easy to
   miss: nothing fails without it, the subcommand is simply absent, so an agent
   added without this step can never sync its box-side config back.

Step 3 is no longer a 1,300-line clone and step 6 is no longer a wire change —
see the backlog below, and
[`agents-remaining-work.md`](./agents-remaining-work.md) for what is still open.

### What a new agent actually costs, measured

The deliverable of the agents-as-packages work is this number, not the claim.
Two paths, both real and both exercised:

**An agent installed from a package — nothing in this repo changes.**
`agentbox agent add <package>` loads the package once, validates its
`AgentSyncSpec` and snapshots it into `~/.agentbox/agents.json`; every reader
resolves it from there, synchronously and without importing the package. Proven
with a two-file package (`package.json` + one `index.js` exporting `agentSpec`)
that imports **no `@agentbox/*` module at all**: after `agent add` it appears in
`AGENT_SYNC_SPECS`, resolves by id and by alias, satisfies `isRuntimeAgent`, and
is dispatched by `stageAllAgentStatic` into every cloud provider's snapshot —
with zero edits to AgentBox. A plugin cannot shadow a built-in id or alias, and
that refusal is enforced at add time.

That path covers DATA. An installed agent that also needs docker behavior still
has to have its `AgentSyncModule` loaded, which is the remaining half.

**An agent compiled in — its own package, plus what the open phases still hold.**
`@agentbox/agent-example` is the canary: a real hidden agent with real behavior,
four files of its own. Everything still needing a hand edit is listed in one
place, `apps/cli/test/_agents-in-cli.ts`, whose doc names the phase that removes
each. It currently has **4 callers**, all in `apps/cli` — the module and command
tables and the runtime probes that phase 2 moves into the agent packages. When
that file has no callers, the claim is a test result rather than a promise.

#### The Pi datapoint

Pi (`packages/agent-pi`) is the first REAL agent added since the above was
written, so it is the honest measure rather than the canary's.

What the checklist promised held: the registry row, the config row, the package
and the two literal table arms were the whole of it, and the install seam needed
nothing — one `install` recipe drove the docker derived layer with no provider
edit anywhere. `list`, `attach`, `fork`, `agent-sessions`, `argv-prefix`, the
whole command factory, seeding, staging, credential fan-out and every cloud
provider picked Pi up from data alone.

What it did NOT cover, and what a fifth agent should expect:

- **The per-agent tails are real.** `_run-queued-job.ts` (the `-i` path),
  `dashboard.ts` + `compositor.ts` + `sidebar.ts`, `inspect.ts`, `prepare.ts`,
  the cmux/herdr status maps, `wrapped-pty/run.ts`, the drive session priority,
  and nine hub files each needed a literal edit. None of them fails a test when
  skipped — they degrade silently, which is what makes them expensive.
- **Two shared gaps only a live smoke found**, both fixed generically rather
  than for Pi: the default pull ignored `AgentPullSpec.categories` (so an agent
  whose config is directories-of-items could never pull a box-created item back
  once the host had that directory), and it offered agentbox's own `seeds` back
  to the host as if the user had written them.
- **A two-letter id broke a guard's assumption.**
  `no-agent-named-exports.test.ts` matched `[A-Za-z_]*(?:claude|codex|…)`, which
  is safe only because those names are long. A bare `pi|Pi|PI` alternative
  matched **60** innocent exports (`ping`, `pickFreePort`, `SPINNER_FRAMES`,
  `ApiErrorCode`). The pattern now carries a boundary rule for short ids, with
  both the catches and the rejects pinned.
- **Two test fixtures were machine-dependent, not agent-dependent.**
  `credential-reconcile.test.ts` overrode backups for three agents by name and
  let the rest fall through to the real `~/.agentbox`, so any developer with a
  fourth credential backup saw a spurious push. Fixtures over agents should
  cover the registry, not a literal three.

Live-validated on docker: derived `dev-pi` layer, seeded activity extension
reporting `idle`/`working` through the generic `agent-state` op, a real
authenticated `pi -p` turn, `download pi`, and full host->box session teleport
(the box's Pi recalled the host conversation's first message, checked against
the host transcript rather than taken on trust).

---

## Provider status

| | docker | hetzner | e2b | daytona | DO | vercel |
|---|---|---|---|---|---|---|
| agentless base | yes | yes | yes | yes | yes | yes |
| agents as a derived layer/snapshot | yes | yes | yes | yes | yes | yes |
| per-box agent selection | yes | yes | yes | yes | yes | yes |
| install into a live box on demand | yes | yes | yes | yes | yes | yes |

Every provider now carries the same three tiers.

Every cloud box gets per-agent credential isolation at **create**: an
`agentbox claude --provider <cloud>` box seeds only claude's credential, and the
other agents' symlinks dangle. On a provider with an agentless base that now
holds across pause/resume too — verified live on hetzner and daytona.

> **Resolved:** daytona used to re-materialise the other agents' credentials on
> resume. It was never host re-seeding (proven with the relay stopped and the
> backend's `uploadFile`/`exec` instrumented); the archive/restore re-applied
> content from a baked base that contained every agent's credential paths. The
> agentless base removes the source, and a resumed box now shows only its own
> agent's credential.

### The three tiers, per provider

Everything below is the same idea as docker's `FROM base` layer: an agentless
base, one artifact per agent set on top of it, and a runtime install as the
fallback when no matching artifact exists. Only the *derive mechanism* differs —
there is no shared `deriveAgentSnapshot` over `CloudBackend`, because
hetzner/DO's `backend.exec` is gated on a per-box SSH key and cannot address a
bake VPS.

| provider | how a variant is derived | measured cost |
|---|---|---|
| docker | `FROM base` + recipe | seconds |
| e2b | `Template().fromTemplate(base)` — declarative, no boot | **43s** |
| daytona (container) | recipe appended to the same Dockerfile build; the builder's layer cache serves everything below it | **77s** (base: 3m18s) |
| daytona (linux-vm) | boot the base snapshot, install, stop, cold-snapshot | untested live |
| hetzner | boot the base snapshot, install over ssh, re-snapshot | ~3.5 min |
| digitalocean | boot the base snapshot, install over ssh, re-snapshot | see below |
| vercel | boot the base snapshot over the SDK, install, re-snapshot | see below |

The recipes are the same `AGENT_SYNC_SPECS.install` entries in every row, so a
baked agent and a runtime-added one are byte-identical in layout.

### Rules that cost us a live debugging cycle each

- **The base pin defeats variant selection.** Every bake pins
  `box.image<Provider>` to the base's own name, so by create time the image ref
  usually *is* our base rather than the sentinel. Hetzner and daytona both need
  a `refIsOurBase` escape that treats it as "no explicit choice", and so does
  DigitalOcean; e2b doesn't, because its backend ignores `req.image` entirely.
- **A variant bake must not pin, share, or adopt.** `box.image<Provider>`, the
  custody record and base adoption are all single-slot: a variant written into
  any of them makes every box on that provider boot one agent's snapshot.
- **`base` must stay the agentless base**, never "the most recent bake".
  Provider-generic readers (freshness, bake sharing, `prepared-custody.ts`) read
  `base.contextSha256` / `base.imageRef` and assume exactly that.
- **A variant must match the base's class/shape.** On daytona a snapshot's class
  is immutable, so the variant takes its class from the base rather than from
  config — a `box.daytonaClass` that disagrees with what was baked would
  otherwise produce an unbootable pairing.
- **Derived bakes log in as the box user, not root** (hetzner, DO): the base
  already carries `PermitRootLogin no`, so a root key is accepted by cloud-init
  and then refused by sshd — which looks like an unexplained `waitForSsh`
  timeout.
- **DigitalOcean cloud-init must stay ASCII.** DO truncates user-data at the
  first non-ASCII byte, so a single em-dash in a comment silently drops the
  whole document: no key is injected and ssh fails with "Permission denied
  (publickey)". Hetzner's derived generator has one; DO's copy must not.
- **A DO snapshot only boots in the regions it lists.** The derived bake reads
  `snapshot.regions` and moves the temp Droplet into one of them rather than
  trusting `box.digitaloceanRegion`. Hetzner has no analogue — its snapshots are
  account-wide.
- **Verify the binary on the BOX USER's PATH**, not just that the build exited
  0. A native installer run as root writes into `/root` and does both.
- **Prerequisites are not all Debian.** Vercel sandboxes are Amazon Linux 2023,
  so `renderPackageInstall` dispatches on the package manager the box actually
  has (`apt-get` | `dnf` | `microdnf`) instead of hardcoding `apt-get`, which
  exits 127 there. Codex's `bubblewrap` is additionally marked
  `packagesOptional` — it ships a bundled sandbox and only warns without the
  system one, so a missing package must never cost a whole box create. New
  prerequisites default to REQUIRED and have to opt into being skippable.
- **A vercel snapshot carries no name, label or tag.** `createSnapshot` accepts
  only `{sessionId, expiration}`, so `vercel-prepared.json` is the *only* record
  of which snapshot is which — there is no server-side orphan sweep, and the
  destroy / `checkpoint rm` guards derive their protected set from that file.
- **Guard every shared tier, not just the base.** Vercel's `destroy` protected
  one id, relying otherwise on `currentSnapshotId === sourceSnapshotId`. That
  source is *session*-scoped and can be absent on a resumed session, so any
  shared snapshot that was not the base — a variant, or a checkpoint — could be
  deleted out from under every box that boots it.
- **Vercel needs no pre-snapshot `sync`.** `sb.snapshot()` stops the sandbox
  before imaging, so the page-cache race that silently emptied hetzner/DO
  snapshots does not apply. Adding one would just cost a resume cycle.

### Per-variant records and GC

Each provider keys one record per agent set under `variants` in its own
`~/.agentbox/<provider>-prepared.json` (`''` = the agentless base), so baking
codex never invalidates the claude artifact. Schema bumps: hetzner 3,
digitalocean 3, e2b 2, daytona 2 — all with lossless migrations that seed
`variants['']` from the existing `base`.

GC differs by how each platform addresses artifacts:

- **hetzner / daytona / digitalocean / vercel** — id- and name-addressed
  snapshots, so a rebuild orphans its predecessor. All four reap it, but only for
  that exact variant and only after the replacement is recorded, so a failed bake
  never leaves you with no base. Hetzner, DigitalOcean and Vercel had no
  base-snapshot GC at all before this.
- **e2b** — templates are *named*, so rebuilding `agentbox-claude:latest` moves
  the tag rather than orphaning an id. There is also no `Template.delete` in the
  SDK to reap one with.

Identifying a snapshot's tier from the platform side varies too: hetzner carries
an `agentbox.agents` label (`none` for the base), while daytona's
`snapshot.create` accepts only name/image/resources/region — so there the **name**
is the only channel, hence `agentbox-<set>-<fp12>`. DigitalOcean is the same: a
snapshot carries no tags, and its name is doubly load-bearing because it is also
how the bake recovers the snapshot id after the async snapshot action completes.

---

## Backlog: where the seam still leaks

The *install* seam is clean — one `AGENT_SYNC_SPECS` row drives the docker
derived layer, every cloud derived snapshot, and `ensureAgentInstalled`, so a
baked agent and a runtime-added one are byte-identical. Everything below is a
place where agent knowledge still lives as **code** instead of data. None of it
is broken; all of it is work a fourth agent would pay for.

### 1. `agentbox download` duplicates the registry's paths, in reverse — **partly done**

Fixed: the box roots and the pull item lists now derive from the registry.
`agentBoxDir(agent)` reads `staticPaths[0].boxDir`, and each spec carries an
`AgentPullSpec` (`items` / `categories` / `jsonMerges`) that
`CLAUDE_PULL_DIR_CATEGORIES`, `CODEX_PULL_ITEMS` and the two opencode lists are
derived from. A drift test asserts the derivation and that every agent declaring
`staticPaths` also declares how to pull them — the gap that let `download` be
forgotten silently.

`AgentPullSpec` is deliberately NOT `staticPaths`: that field's
`exclude`/`include` are push-direction hygiene (claude drops `projects` and
`sessions` on the way in) while the pull's real filters are different ones, and
opencode's `update: true` state root must never be pulled at all — newest-wins is
the opposite of pull's additive rule. The test pins that exclusion.

Also fixed: the pull is now **one implementation and a per-agent hook**.
`pullFlatConfigViaTransport` is the DEFAULT — it derives box dir, host dir and
items from `AgentPullSpec` plus the group rule that field already documented, so
an agent declaring a row gets a working `download` with no code (pinned against
the `example` canary). The codex and opencode functions were that body twice,
differing only in that mapping. Claude registers an `AgentPullModule` because its
pull genuinely differs — category children plus a JSON registry merge with a
container->host path rewrite.

The docker-side duplicate is gone too. It existed because the pull must work
against a STOPPED box and `SyncTransport` needed a running container;
`createDockerVolumeSyncTransport` mounts the config volume at its box path, so
box-absolute paths resolve identically and `download-<agent>.ts` has no
`box.provider` branch left. Two bugs fell out of the collapse: codex and opencode
each had their own inventory shell dialect, and codex's `cp -a` dropped the
`chmod 0600` the shared path applies to `auth.json`.

**Deliberately not collapsed further.** An agent's state is not always a file
tree — codex keeps five SQLite databases and opencode one, and a database cannot
be copied: the data lives in the write-ahead log, so the main file alone is stale
(measured: codex's `state_5.sqlite` was 4 KB against a 1.79 MB `-wal`, and a
byte-copy of it reports "no such table"). That is why the pull is a hook with a
default rather than one generic function. `pullSqliteSnapshot` is the supported
way to pull a database — SQLite's online-backup API through the box's `python3`
or Node 24's `node:sqlite`, both already in the image, so it needs no re-bake.

**Still open:** the three `download-<agent>.ts` commands remain separate files
(~90 lines each) rather than one registry-driven command.

### 2. ctl carried a second copy of the credential paths, frozen at bake — **done**

`WATCHED_CREDENTIALS` (`packages/ctl/src/credentials-watcher.ts`) mirrors
`AGENT_SYNC_SPECS[..].credential.boxAbsPath`, and a drift test keeps the two in
lockstep. The sharper problem was that **`agentbox-ctl` is baked into the
image**: a box built from a snapshot baked before an agent existed watched the
old list, so that agent's credential refresh was never reported to the host until
the image was re-baked — and a plugin-supplied agent, which can never be baked,
was invisible forever.

Fixed: ctl now **pulls** the list from the host over an `agents.list` relay RPC
at daemon start, modelled on `tool.list`. Pulled rather than pushed as a file, so
the payload's shape stays host-side and no provider (including a community one)
has to write it. That turns adding an agent from "re-bake every base" into
"restart ctl".

Two rules the implementation depends on, both learned the hard way:

- **Failure is silent and keeps the baked list.** An unreachable relay, an older
  host, or a malformed payload must all leave the box watching what it already
  watched — never nothing.
- **The fetch is never awaited on the startup path.** On a cloud box the
  in-sandbox relay parks every RPC on a `HostActionQueue` that has no timeout and
  expires entries only when the host poller drains it, so with the host off the
  call never settles. The watcher therefore starts on the baked list and is
  upgraded via `setFiles()`; the fetch is additionally bounded at 30s.

Why this matters most for Claude specifically: an OAuth refresh **rotates** the
refresh token, killing every other copy (host backup, other boxes). The watcher
posting the fresh blob to the relay is what keeps the fleet logged in, so a box
whose ctl doesn't watch a credential silently degrades the whole fleet's login
for that agent, not just its own.

**Still open:** a box already *running* when the host's agent list changes picks
it up only on the next ctl restart. `ToolLinksWatcher` solves the equivalent with
`agentbox-ctl tool relink` over `Provider.exec`, but that works because tool links
are on-disk state another process can rewrite — this list lives in the daemon's
memory, so the same push needs a ctl socket op.

### 3. Community provider plugins cannot support per-agent variants — **done**

Fixed: the SDK now re-exports `variantFingerprint`, `normalizeAgentSet`,
`agentSetArg`, `resolveAgentSpec`, `resolveAgentInstall`, `renderInstallRecipe`
and `renderPackageInstall`, and `docs/provider-plugins.md` documents the opt-in
with a worked example. Purely additive — `agents` was already optional on
`PrepareOptions` and `CloudProvisionRequest`, so a plugin that ignores it still
degrades gracefully and `SDK_API_VERSION` stays at 2.

The published surface is pinned by `pack:test`, which installs a real packed
tarball in isolation and fails naming any missing export.

### 4. The per-agent command tail — **mostly done**

`agentbox claude`, `agentbox codex` and `agentbox opencode` were three
hand-maintained files totalling **4,866 lines** for what is one command.
Measured, not estimated: normalise the agent's name out of codex and opencode and
`diff` is 671 lines — ~1,070 were byte-identical. Claude was closer than its line
count suggested: normalised against codex it added exactly **four** options
(`--plan`, `--headless`, `--code`, and one login flag); its extra ~600 lines were
the headless-login machinery and the `--plan` / plugin-rebuild blocks woven
through a body that was otherwise the same.

They are now one factory (`apps/cli/src/agents/command/`) and one descriptor per
agent, each living in its own package:

| file | holds |
| --- | --- |
| `agents/command/options.ts` | the 38-option surface, in order |
| `agents/command/create-action.ts` | the create body: `-i` queue path, gates, hub route, cloud delegate, docker create |
| `agents/command/start-attach.ts` | `<agent> start` / `<agent> attach` |
| `agents/command/login.ts` | the default `<agent> login` |
| `agents/command/host-services.ts` | the app capabilities hooks reach through `ctx.host` |
| `packages/agent-<id>/src/cli/runtime.ts` | the agent's docker bindings + its own login code |
| `packages/agent-<id>/src/cli/cli-spec.ts` | the descriptor: help strings that genuinely differ, plus hooks |
| `agents/<id>/command.ts` | a ~15-line shim: literal import of the spec, into the factory |

Claude's descriptor was the last to move, and the reason it lagged is worth
keeping: it is the only agent with `hooks`, and those hooks called UP into the
app. `AgentHostServices` inverted them — the agent asks, the app supplies — which
also made the setup wizard reachable by any agent instead of just claude.

Two tables, both with literal specifiers, both under `agents/`: the lazy
`AGENT_MODULES` (`index.ts`) for spec/login/teleport/runtime, and the eager
`AGENT_COMMANDS` (`commands.ts`) for the commander tree. Lazy vs eager is not
cosmetic — `session-teleport` and `agent-sessions` load a module on paths that
must not pull three commanders' worth of imports behind them.

**Per-agent behavior is a closed set of five hooks**, and claude is why they
exist: `preflight` (its `--plan` payload), `beforeCreate` (the setup wizard),
`afterCreate` + `afterVolumeSync` (plugin native deps, setup-skill seeding,
codex's activity hooks), `attachExtras` (clipboard paste), plus `extendCommand`
for `--plan` itself. If a sixth is ever needed the body is not actually shared,
and forking that agent's path is the honest answer.

Some things that looked like accidents turned out to be deliberate and are now
**declared** rather than forked:

- `signInOfferTiming` — claude asks you to sign in BEFORE its wizard can spend
  minutes re-baking a stale base; codex and opencode ask after the hub-routing
  decision, so a box the control box will build never prompts for a local login
  it will not use. Unifying either way loses one of those.
- `acceptsSeedPrompt: false` (opencode) — its launch takes no opening turn, so a
  resync-conflict warning goes to stderr instead of becoming a prompt.
- `ensureInstalledOnCreate: false` (claude) — it has never probed for its binary
  on create, and turning that on is a behavior change on the daily driver's hot
  path, not a cleanup.

**How the collapse was kept honest.** `test/_fixtures/agent-cli-surface.json` was
captured from the three hand-written commands BEFORE the factory existed: every
flag, short form, description, default and positional argument of all three
commands and their subcommands. It is unchanged, which is the whole claim.

The fixture is also not sufficient, and both ways that surfaced are worth
recording. A live smoke caught the one regression it structurally cannot: with
teleport living in each agent's own hook, `agentbox opencode -c` — no teleport,
therefore no hook — silently ignored the flag and built a box instead of
refusing. The flag was still declared, so the fixture was green. Teleport now
resolves in the shared body for every agent, and
`agent-resume-flags.test.ts` drives that body directly so it cannot regress.

Review also caught the one regression the factory itself introduced: claude's
`--plan` marked the run hub-incompatible but left the *reason* unset, so
`agentbox claude --plan … --via-hub` printed a blank warning line before building
locally. The reason had been an optional field on the preflight result that a
hook could forget; it is now only `text.hubIncompatibleReason`, which
`AgentCommandText` requires — the omission is no longer representable.

And one the fixture was never going to see because it predates the factory: the cloud `attach` / `start` branches fell back to the REGISTRY
default session name (`opts.sessionName ?? 'codex'`, three copies) while the
docker branch read `<agent>.sessionName`, so a custom session name meant create
started one session and a later cloud attach silently created a second. One line
to fix now that there is one; `agent-session-name.test.ts` pins it.

What was already done before this is the identity half. There used to be **eight** types spelling the
same thing — `SyncAgentKind`, `AgentKind`, `AgentName`, `TeleportAgent`,
`CloudAgentKind`, `ForkAgent`, `CmuxAgentMode`, `HerdrAgentMode` — plus ~35 more
sites re-declaring `'claude' | 'codex' | 'opencode'` inline. All of them now read
`AgentId` / `AgentMode` / `QueueAgentKind` from `@agentbox/core`.

`AgentId` is an **open `string`**, not a union: an agent is a registry row, so
which ids are valid is a runtime fact. `isAgentKind` (`@agentbox/core`) answers
for the built-ins — a dependency-free leaf has no registry to ask — and
`isRuntimeAgent` (`@agentbox/sandbox-core`) answers from the registry. That is
the same split as `isProviderKind` vs `isRuntimeProvider`, for the same reason.

The trade is real and is paid for by tests, because the compiler no longer lists
the sites a new agent misses:

- `no-inline-agent-union.test.ts` fails if any file re-declares the agent set as
  a literal union. It is tuned to the *agent set*, not to any union containing
  two agent names — `OpenInApp` in `commands/_open-in.ts` legitimately lists
  `Claude.app` and `Codex.app` beside herdr, cmux and finder, and a fourth agent
  does not belong there.
- `agent-module-table.test.ts` asserts `AGENT_MODULES`'s keys equal `agentIds()`,
  that each module carries its registry row **by reference**, and that a
  `teleport` resolver is present exactly when `caps.teleport` is `'full'`.
- `agent-command-coverage.test.ts` asserts the eager command table covers the
  registry, and that each entry carries both a command and an attach wrapper.
- `agent-cli-surface.test.ts` diffs the whole CLI surface against the fixture
  above.
- `agent-resume-flags.test.ts` drives the create body's `-c` / `--resume`
  handling for every agent, including one with no teleport.

Deleting any of those silently re-closes the type. Writing the sweep also
surfaced four more places where a capability had been spelled out a second time
as a literal — `agent-sessions`' `ResumableAgent`, `_cloud-attach`'s resume gate,
`attach`'s agent-priority map and the custody store's valid-agent segments — all
of which now read `caps.resume` or `agentIds()`.

**Deliberately not done:** `AGENT_SYNC_SPECS` does not derive from the module
table. The table is lazy and the specs are read synchronously in ~40 places
across sandbox-core / cloud / docker / relay / hub; deriving would make all of
them async to no benefit, since a spec is small pure data rather than a heavy
SDK. The registry stays the synchronous source of truth and the module table is
the behavior tier above it.

### 5. Spec fields that were declared but inert — **partly done**

Three fields shipped on `AgentSyncSpec` with **zero consumers**, so an agent that
set them got silence and the real behaviour stayed hardcoded elsewhere.

Fixed:

- **`boxRunEnv`** now drives the in-box env on both the docker and cloud paths.
  They had already drifted: cloud set `OPENCODE_CONFIG_DIR` and silently omitted
  `XDG_STATE_HOME`, so a cloud box kept OpenCode's `model.json` outside the dir
  the snapshot captures and lost the selected model across a resume, while a
  docker box kept it. A test now asserts docker and cloud agree with the
  declaration key for key.
- **`caps.resume`** gates `fork`'s `--session` refusal and **`caps.teleport`**
  gates `prepareTeleport`, instead of both testing `agent === 'opencode'`. The
  refusal text moved onto the capability as `caps.teleportStubReason`, so
  declaring `teleport: 'stub'` is now the whole job — no `case` in
  `prepareTeleport` and no per-agent module (`session-teleport/opencode.ts` is
  gone).

**Still open** (and one now closed):

- **`caps.activitySource`** is now a LIST (`hooks` / `plugin` / `scraper`) and
  wired — see section 7. Its old single value under-described reality: claude is
  hooks-primary with a scraper backstop, codex is scraper-primary, opencode is
  plugin-only.
- **`watch` / `roots`** reach the box (see item 2) but nothing consumes the
  `backup` route yet. Wiring it means routing through `cp.toHost` behind a
  `box.agentFileSync` config, with the trust rule `download.claude` already uses:
  a destination inside the box's host project folder is silent, anything outside
  prompts. **Parked by choice:** no built-in agent has a file worth mirroring, so
  the route would ship with no declarer — it wants the agent that needs it.
  (`roots` is filed here but is a different animal: it is a host-side `download`
  field that never reaches a box, and nothing resolves a pull group through it.)

### 6. Hook seeding was three hand-written functions, and docker-only — **done**

`seedSetupSkillIntoVolume` / `seedCodexHooks` / `seedOpencodePlugin` were the
same throwaway-container copy written three times, differing only in which file
went where. They are now `AgentSyncSpec.seeds` — baked source, destination
relative to the config root, and the `runtime/_shared` basename to fall back to —
with `launchFlags` alongside for the argv an agent needs to LOAD what was placed
(codex ignores a `hooks.json` without `--enable hooks
--dangerously-bypass-hook-trust`).

Living in `@agentbox/sandbox-docker` meant **the cloud providers never ran any of
it.** OpenCode's state plugin is its only activity source
(`caps.activitySource: 'plugin'`) and was not even shipped to the VPS providers,
so every cloud OpenCode box reported `unknown` forever; codex never got its
`hooks.json`, nor the flags to load it. Exactly the `boxRunEnv` drift, one item
earlier.

Both transports now run one plan built in `sandbox-core`, asserted equal key for
key. The cloud path prefers the baked copy and falls back to uploading the host's
staged `runtime/_shared/` copy — which is what makes the fix reach **existing**
snapshots: the deployed Hetzner base has no OpenCode plugin to copy, and a
re-`prepare` of every provider would otherwise have been a prerequisite.

Three things, all about WHERE the seed call goes — the declaration was the easy
half:

1. **Seeding on `attach` but not on `start`.** The first version put the cloud
   call on the CLI action closures — and `wireAttachAction` / `wireStartAction`
   are separate bodies, so one edit covered one of them. Found by deleting the
   plugin from a live Hetzner box and running `start`.
2. **Seeding a box that was still paused.** Moving the call onto the two launch
   primitives fixed (1) but left them disagreeing: `cloudAgentAttach` resumes the
   box first, `cloudAgentStartDetached` did not. A seed exec against a paused
   sandbox fails, and best-effort means it fails *silently* — so the agent
   launched without its plugin on exactly the resume-from-pause path where an
   older box needs the seed most. Caught by Bugbot.
3. **A spinner frame is not evidence.** The create-time seed log line never
   rendered for OpenCode — set and replaced inside one spinner frame — while the
   codex one happened to survive. The file in the box was the ground truth; the
   log was an artifact of timing.

(1) and (2) are the same mistake twice: the ordering rule ("box running, then
seed, then launch") was re-derived at each call site. It is now stated once, on
`seedDeclaredFilesForLaunch`, and the seed for the detached path lives *inside*
`startDetachedCloudAgent` after its own `provider.start` — so the control box's
create worker gets it too, not just the CLI.


### 8. The credential rule was claude's JSON inlined behind role names — **done**

`shouldAcceptCredentialUpdate` dispatched on data but its branch hardcoded
`claudeAiOauth.expiresAt`, and `oauthExpiresAt` / `oauthRefreshExpiresAt` were
role-NAMED with no dispatch at all — invisible to the naming guard. Any agent
that is not claude got `null` and fell through to last-writer-wins, which for a
ROTATING refresh token accepts a dead blob: the refresh rotates the token, so an
older copy logs out every box holding the newer one.

`credential.freshness.jsonPath` carries the rule now. Claude declares
`['claudeAiOauth','expiresAt']`; an agent declaring nothing keeps
last-writer-wins.

**Data, not a module hook — and the reason is not the hub.** `agentbox-relay` is
a separately spawned process bundled from `@agentbox/relay` alone (deps: config,
core, sandbox-core) and never calls `registerAllAgentModules()`, yet it is what
runs `CredentialsFanout`. A hook there would have silently reintroduced the very
bug being fixed. The relay already reads the registry synchronously.

Two things deliberately unchanged, both load-bearing:

- **`freshness` stays off the `agents.list` descriptor.** ctl never orders blobs
  — it shape-validates and posts — so this is host-side in the same category as
  `hostBackup`, which the descriptor already strips.
- **`realShape` stays a frozen two-value union.** Widening it is the one change
  that is NOT safe: ctl drops a watch whose shape it does not recognise
  (`agent-registry.ts`), and an empty list makes it fall back to the list baked
  into its image — which a plugin agent can never be in, so the result is no
  credential watch at all. `agentbox agent add` now refuses an unknown
  `realShape` for exactly that reason, where there is a person to tell.

The docker sync script is the rule's second implementation, in `jq`, in a
container that has only `jq`. Its path is rendered from the same spec entry and
pinned by a drift test in both directions.

### 7. Activity status was five named fields, and OpenCode's was dropped — **done**

`BoxStatus` carried a required `claude` plus optional `codex`/`opencode`, three
`<agent>-state` ops, three reporter setters and three snapshot branches; the hub
`/api/v1` Box carried five named fields; `list`, the dashboard, the attach footer
and the relay's queue gate each re-spelled the same three names. A fourth agent
could not report activity — not "was not wired up", but had nowhere to put the
value.

Status is now a **keyed map** (`AgentStatusMap` in `@agentbox/core` — the leaf
both ctl and the relay can reach, since ctl depends on the relay and not the
reverse), with one `agent-state <agent> <state>` op behind it. ctl learns which
tmux sessions to probe from the `agents.list` descriptor it already fetches, so
an agent added after an image was baked is probed **without a re-bake** — the
same reconcile shape `CredentialsWatcher` uses (start on the baked list, upgrade
detached, never on the daemon's critical path).

**Three live bugs came out of it, all of them "the field simply wasn't there":**

1. **OpenCode's activity was produced, transported, persisted, and then dropped.**
   `opencodeActivity` existed nowhere in the repo. Its plugin has always reported
   a real state, and `lifecycle.ts` projected only the session title — so `list`
   could print a bare `opencode` and nothing more, and an OpenCode box that
   errored could not even raise the box's status to `error`. PR #344 had just
   finished making that plugin reach cloud boxes, and the result was invisible.
2. **`agentbox agent state` / `wait-for` / `get-plan-question` were claude-only.**
   Not by a missing flag: `getAgentState` returned `{ claude }` and every wait
   predicate took claude's status entry, so on a codex or opencode box they read
   claude's permanent `unknown` forever. They now read the box's most active
   agent, or `--agent <id>`.
3. **The hosted (Postgres) plane emitted none of the five fields**, unlike the
   in-process one, so `agentbox list`'s AGENT column silently degraded to `-`
   against a control box.

**Two things deliberately did NOT change, and both are load-bearing:**

- **`BoxStatus.schema` stays `1`.** `readBoxStatus` and the relay's
  `isValidBoxStatus` both reject anything else outright, so a bump would blank
  every field on every existing reader rather than degrade. `agents` is an
  additive field — the same discipline `probed`, `expose` and `sessionTitle`
  already follow on this type — and back-compat is read-time normalization, the
  rule `normalizeLastAgent` states for persisted agent names.
- **The named fields are still written and still published.** The snapshot writes
  them as a *derived* mirror of the map (asserted derived by a test, so it cannot
  quietly go stale), and the hub payload still carries all five plus the new
  `opencodeActivity`. Skew runs both ways — a baked ctl outlives the host that
  reads it, and a laptop CLI is routinely a different build from the control box
  it points at — and those fields drive the queue's working gate, autopause and
  keepalive, not just display. The macOS tray decodes the three `*SessionTitle`
  keys **by name, as optional strings**, so removing one would blank its box
  labels silently rather than fail loudly.

The seeded hook/plugin files still invoke `<agent>-state`, and ctl still ships
those command names (generated from the built-in list). Agent config volumes are
**shared between boxes**, so a `hooks.json` seeded by a newer image can be read by
a box running older baked ctl; repointing those files at `agent-state` would
break activity reporting on exactly that box, silently.
