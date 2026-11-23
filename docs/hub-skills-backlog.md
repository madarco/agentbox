# Hub skills — backlog

Live backlog for [`hub-skills-plan.md`](./hub-skills-plan.md). Updated during
each phase, not at the end.

## Phase 1 — implementation plan (2026-11-22, implemented)

Scope: custody `skills` scope, normalization + tree hash, `/api/v1/skills`,
PC-side secret scan, the automatic first seed, the `agentbox skills` TUI. No
delivery to boxes, no web page (Phase 1b).

1. **Custody scope.** `skills` joins `CUSTODY_SCOPES` in
   `packages/relay/src/custody/store.ts` and its three hub mirrors
   (`api/v1/lib/custody-path.ts`, the custody list route's prefix regex,
   `lib/custody-view.ts` with a Custody-page label). Layout:
   `skills/<name>/meta.json`, `skills/<name>/<treeSha>.tar.gz`,
   `skills/.seeded`.
2. **Hub slice** `apps/hub/lib/backend/skills.ts`, pure over a structural
   custody interface (the routes get the store through
   `globalThis.__AGENTBOX_HUB_CUSTODY`, like the custody routes): name rules,
   list (+ `seeded`), import (streamed tarball, meta update, keep the newest 5
   versions, write `.seeded`), tarball open, discard (whole prefix).
3. **Routes**: `GET /api/v1/skills`, `PUT|DELETE /api/v1/skills/{name}`,
   `GET /api/v1/skills/{name}/tarball[?version=]`. Normal `/api/v1` gate.
   OpenAPI entries.
4. **CLI library** `apps/cli/src/lib/skills/`: local discovery (the six known
   user skill dirs; `agentbox-*`, dot-names and claude's `synced/` skipped),
   frontmatter check, normalization (symlinks dereferenced, a broken link fails
   the skill), tree hash, tarball build/extract+verify, secret scan with the
   placeholder / 40-hex / test-fixture suppressions, seed and sync
   orchestration.
5. **Client** methods on `HubApiClient`: `listSkills`, `uploadSkill`,
   `downloadSkill`, `discardSkill`.
6. **Command** `agentbox skills`: @clack TUI (side-by-side table, then upload /
   download / discard multiselects) and the flags `--list [--json]`,
   `--upload <names…>`, `--upload-all`, `--download <names…>`,
   `--download-all`, `--discard <names…>`, `--yes`, `--allow-findings`.
7. **Automatic first seed** in `finalizeControlBoxState` (after credentials and
   bakes) and on create (`agentbox create`, `agentbox <agent>`), quiet and
   best-effort, gated on `skills/.seeded`.
8. **Config** `skills.maxSkillBytes` (default 50 MB), enforced on the PC
   before upload.
9. **Docs**: public page + CLI reference + configuration key; this backlog;
   plan status.

## Phase 1b — implementation plan (2026-11-22, revised after review)

Scope: the hub web Skills page (list + discard), the System page swap, and a
skills digest on cloud bakes so a base reads stale when the host's skills
change and a control box declines a PC bake whose skills differ from its
library.

1. **Skills digest.** sha256 over sorted `<name>:<treeSha>` lines of the skills
   the first seed would upload (discoverable, valid, no scan findings), so a PC's
   digest equals the library's when they hold the same skills. The pure
   discovery/tree/scan/frontmatter modules move from `apps/cli/src/lib/skills/`
   into `@agentbox/sandbox-core` so the providers can compute it.
2. **Recorded, not folded.** The first draft folded the digest into
   `variantFingerprint`; the review showed why that's wrong: `contextSha256` is
   the cross-machine identity bake sharing compares (a PC adopting a control
   box's bake and the reverse), two machines' skills differ, so every share for
   anyone with skills would stop — a regression. Instead each bake records
   `base.skillsDigest` + `base.skillsHost` (the machine id) next to
   `contextSha256`, in the five providers whose bakes stage host static config
   (daytona, hetzner, vercel, e2b, digitalocean). Docker and remote-docker don't
   bake host config and are untouched.
3. **Staleness is judged by the machine that baked.** `prepare`'s skip-fast
   re-bakes when the record was stamped here and this machine's skills changed
   ("your skills changed since the last bake"); `evaluateBaseFreshness` (CLI)
   and the hub's provider freshness report such a base `stale` with that reason
   (`withSkillsFreshness`). A record from another machine, or from before this
   change, is never judged on skills — no one-time re-bake on upgrade.
4. **Library gate on the control box: deferred to Phase 2.** Implemented, then
   removed after the second review: declining a PC's shared bake makes the
   control box bake from its own (empty) home, so its boxes got NO skills
   instead of the PC's — a regression, since before this phase it adopted the
   bake. The gate only helps once the control box can bake (or deliver) the
   library's skills. The recorded `skillsDigest` is what it will compare.
5. **Web.** `/skills` page in the hub (pure `/api/v1` client): name,
   description, size, files, source PC, updated, versions; discard with a
   confirm. Sidebar entry. The System page's "Skills · this control box" section
   becomes a library summary (from the custody manifest it already fetches)
   linking to `/skills`.
6. **Docs.** Public skills page (web UI + stale bases), deployed-hub web UI
   list; plan status.

## Phase 2 — implementation plan (2026-11-22)

Scope: deliver the library to boxes, claude first, every provider; plus the two
review items marked must-fix before a remote hub serves skills.

1. **Must-fix: symlinks stay in the skill.** `readSkillTree` resolves a link only
   when its target lies under the skill's own root (realpath), else the skill
   gets a problem and is not uploaded. A top-level skill dir that is itself a
   link (the usual `~/.claude/skills/x -> ~/.agents/skills/x`) is the root, so it
   keeps working.
2. **Must-fix: the tarball route uses custody's elevated byte read** (admin token,
   an enrolled device's token, or loopback on a local hub), not the plain API key.
   `agentbox skills --download` sends the admin token when this PC holds it.
3. **Safe tar on both ends.** `tar.ts` moves into `@agentbox/sandbox-core` so ctl
   (which inlines sandbox-core) reuses the same reader that refuses symlinks and
   `..` paths.
4. **Relay RPCs.** `skills.get` returns the box's resolved set
   (`{library, skills: [{name, version, bytes}]}`); `skills.blob`
   (`{name, version, offset}`) returns one base64 chunk (512 KiB raw) so a
   cloud box's answer fits the bridge's 1 MiB body cap. Served from custody on
   the `/rpc` path and in `executeCloudAction` (both call sites), like
   `history.*`. No custody here, or an unseeded library: `{library: false}`.
   A `readRange` on the custody store avoids re-reading a tarball per chunk.
5. **Selection** rides the box registration, like `autoApproveSafeHostActions`:
   `--skill <names>`, `--no-skill <names>`, `--no-skills` on `create` and
   `agentbox <agent>` → create opts → `BoxRecord.skills` → registration. The relay
   resolves it against the library's CURRENT versions on every `skills.get`
   (pinning and "behind" are Phase 5).
6. **Agent declaration.** `AgentSyncSpec.skills = {dirs, inject}`; claude's is
   `{kind:'dir', path:'/etc/claude-code/.claude/skills'}`. It rides the
   `agents.list` descriptor, so ctl links per agent from data and names no agent.
7. **ctl.** At daemon start (off the critical path, like the history loop) and
   on `agentbox-ctl skills sync`: `skills.get`, download what the manifest lacks,
   verify each tree hash, write the canonical tree under
   `~/.local/share/agentbox/skills/<name>` (vscode-owned, never a shared volume;
   ctl runs as vscode, so not `/opt`), then symlink each skill into every `dir`
   injection point (`sudo -n` creates a root-owned dir once). Removal is
   manifest-based: only what ctl wrote is ever deleted.
8. **Fallback.** Library off or unreachable: nothing changes; the host carry
   still delivers skills as before.
9. **Docs.** Public skills page (delivery, selection flags), CLI reference.

Deferred, with reason (in Open items): excluding `skills/` from config-volume
syncs and static bakes once the library is on.

## Phase 3 — implementation plan (2026-11-22)

Scope: every built-in agent reads the box's library skills, each through the
injection Phase 0 measured, declared as data on `AgentSyncSpec.skills`.

Measured before planning (throwaway container, codex 0.171.0, opencode 1.19.6,
pi 0.73.1, openclaw 2026.11.6): all three non-`dir` injections tolerate a
missing directory (a box with no library, or an older ctl), so the injection
can be unconditional. **Corrected after review (R1 of #445):** pi 0.84.4 and
1.6.0 (what boxes install) print a "skill path does not exist" block on every
launch when the `--skill` dir is missing, so the docker and cloud launchers now
`mkdir -p` it first (`agentLaunchPrelude`), which also covers older snapshots. Same-name collisions between the carried `~/.agents`
copy and the library copy: codex lists both (user + admin scope), opencode
keeps the library copy, pi and openclaw keep the carried one.

1. **`AgentSkillsSpec.inject` grows two shapes**: `flag` (`argv` with a `{dir}`
   placeholder) and `config` (`jsonPath`, for an agent whose own boot task merges
   it). An `env` shape was implemented and dropped after review, see 3. `{dir}` is the canonical box path
   `BOX_SKILLS_LIBRARY_DIR` (`/home/vscode/.local/share/agentbox/skills`), now a
   core constant ctl also uses.
2. **codex**: `dir` → `/etc/codex/skills` (ctl links, like claude).
3. **opencode**: `dir` → `/home/vscode/.opencode/skills` (ctl links). First
   built as `env` `OPENCODE_CONFIG_CONTENT={"skills":{"paths":["{dir}"]}}`; the
   review then found two problems, both measured: a config layer REPLACES the
   user's own `skills.paths` array (a regression for anyone who sets one), and the
   Hetzner/DigitalOcean box.env keeps only `AGENTBOX_*` keys, so the env never
   reached opencode there. opencode scans `~/.opencode/skills` regardless of
   `OPENCODE_CONFIG_DIR`, the dir is unused in a box, and the user's
   `skills.paths` keeps loading next to it.
4. **pi**: `flag` → `--skill {dir}`, appended to the declared `launchFlags` by one
   helper (`agentLaunchFlags`) at the docker and cloud launch sites.
5. **openclaw**: `config` → `skills.load.extraDirs`; its existing
   `openclaw-agentbox-env` boot task merges the library dir next to
   `/opt/agentbox/skills`. openclaw watches its skill dirs, so skills that arrive
   after the task ran still load.
6. **The docker `~/.agents` volume stays** (plan decision 6's condition does not
   hold yet): a box served by a relay with no library (a PC's local relay on a
   remote-hub setup) or built on an image without the Phase 2 ctl gets codex,
   opencode, pi and openclaw skills ONLY from that volume. Retiring it now would
   drop them. Revisit with the carry-exclusion item.
7. **Docs**: public skills page (every agent), plan status.

## Phase 4 — implementation plan (2026-11-23)

See the plan doc's Phase 4 section. Deviations from the plan text: bindings live
in one custody file (`skills/.bindings.json`), not a hub DB table; the pure
resolver is in `@agentbox/core` (a hub route can't bundle `@agentbox/relay`).

## From Phase 4 (2026-11-23)

- **Box scope is API-only.** `PUT /api/v1/skill-bindings?scope=box&scopeId=<id>`
  works; there's no `agentbox skills enable --box` yet (needs box name → id
  resolution in the command). Box bindings of a destroyed box are never
  removed (harmless: no box has that id again).
- **Binding changes reach a running box only on its next sync** (restart or
  `agentbox-ctl skills sync`). Pushing `skills.sync` is Phase 5.
- **The web picker keys the project by the hub's view of the origin URL**: a PC
  remote spelled with an `~/.ssh/config` alias (`work:acme/app`) keys as written
  there, so the preview can miss a project binding the CLI set with the expanded
  key. The box itself resolves with its registration's expanded key, so only the
  picker's prefill is affected.
- **The web picker's workspace is the project's (`Project.workspaceId`, folder
  based on the hub's machine)**; the box's own workspace is joined from its
  origin folder on its origin machine, then its repo. They agree except for a
  repo listed in two workspaces.
- **A PC's local relay still has no library on a remote-hub setup** (the Phase 2
  item): a docker box created on a PC registered with that PC's relay reads that
  relay's custody, so the remote hub's bindings don't apply to it either.
- **Tray**: the create sheet has no Skills picker yet (Phase 6, with the other
  tray surfaces).
- **Review (medium), not fixed:** each `skills.blob` chunk now also reads the
  bindings file and, with workspace bindings, scans the workspace records (adds
  to L1 of #441: resolve once per sync); a workspace lookup that throws resolves
  the box without its workspace bindings, silently (log it); `enable|disable`
  makes three sequential hub calls (parallelize, read only the global scope for
  the hint).
- **L1 (review of #448): docker registrations carry no `repoKey`.**
  `sandbox-docker/src/create.ts` (the register body, ~L901-916) sends
  `originUrl` only, so the relay keys the box with a raw `repoKey(originUrl)`,
  while `agentbox skills enable|disable --project` stores the alias-expanded
  `repoKeyAtEdge` key. A project binding misses a docker box whose remote uses an
  `~/.ssh/config` alias (`work:acme/app`). Fix: send `repoKeyAtEdge(originUrl)`
  in the docker registration, as the cloud path does.
- **L3 (review of #448): a corrupt `skills/.bindings.json` fails open
  silently.** `skills.get` reads it as "nothing bound", so every box gets every
  skill (excludes stop applying) and nothing is logged; `GET
  /api/v1/skill-bindings` shows it empty while `PUT` refuses with "not valid
  JSON". Fix: log/emit a relay event on the tolerant read, and surface the error
  on GET.
- **Discard keeps bindings** (on purpose, from the review): a global `disable`
  must survive a discard + re-import. Bindings for skills that never come back
  stay in the file; `agentbox skills bindings` shows them.
- **`enable --workspace` with a skill not disabled globally** changes nothing;
  the CLI prints a hint rather than offering a "workspace only" mode. Revisit if
  users trip on it.

## Phase 7 — implementation plan (2026-11-23)

See the plan doc's Phase 7 section. Deviation from the plan text: a box binding
now outranks the create flags (box binding > flags > project > workspace >
global), so an approved `skills_propose_install` can widen a box created with
`--skills` / `--skip-skills` / `--no-skills`.

## From Phase 7 (2026-11-23)

Fixed from the `/code-review medium`: the proposal's tar read had no unpacked
cap (a small gzip could inflate into hub memory); a stale carried copy matching
an OLDER library version was proposed as "a new version" (any kept version now
answers `unchanged`); runtime artifacts (`__pycache__`, `node_modules`) made a
carried skill look edited (the PC-side skip compares authored-file hashes); the
pending approval kept the unpacked files alive; `skills_propose_install` had no
dedupe; `download opencode` lacked the step; a proposal in the hub's startup
window answered `pending` with no prompt ever shown (the handler is published
only once the prompt mailbox exists). Still open:

- **Two proposals of different versions of one skill are both parked.**
  Approving the second after the first lands logs "not applied: the library's
  version changed" and the approver sees nothing. Replace the earlier pending
  proposal per name, or surface the outcome as a notice.
- **A proposal from a box with `autoApproveHostActions` is auto-approved**, like
  `memory_propose` (the prompt mailbox's policy applies to every ask under that
  box id). Decide whether library writes should be exempt.
- **Pending proposals live in hub memory** (up to 20, each up to the custody blob
  cap compressed). A hub restart drops them along with the prompt mailbox.
- **The CLI's library skip compares raw tree hashes** (the library stores raw
  trees); the hub answers `unchanged` for any kept version. A carried copy the
  agent ran (with `__pycache__`) and that this PC no longer has as-is is still
  proposed; the approver sees it. Strip runtime dirs at proposal time.
- **`agentbox-ctl download <agent>` reaches the propose step only on docker**
  (the box-initiated `download.claude` RPC shells the host CLI; on cloud only
  `download.workspace` is routed, a pre-existing gap). From a cloud box, run
  `agentbox download <agent> <box>` on the PC.
- **opencode's in-box `.claude/skills` and `~/.agents/skills` are not read**:
  only skill dirs under the agent's own box config dir are, because the docker
  transport mounts that dir alone.
- **An approved MCP install needs `agentbox-ctl skills sync`** in the box; pushing
  the sync is Phase 5.
- **MCP `skills_list` re-implements the library listing** (`libraryNames` next to
  `listSkills`) to avoid hashing; fold together with the L1 stat-only listing.
- **Box bindings of destroyed boxes** (now also written by approved installs)
  are never removed (Phase 4 item).

## Open items

- **`--link` (a PC folder watched and re-uploaded on change)** is not in
  Phase 1. Open question carried from the plan: may a linked folder source be
  updated from a PC other than the one that linked it (another `hostId`)?
- **Discovery dirs are a CLI constant**, not registry data. Phase 2 adds
  `AgentSyncSpec.skills.dirs`; the TUI and seed should read it then, so a plugin
  agent's skill dir is discovered too.
- **The size cap is enforced on the PC only.** The hub's bound is custody's
  streaming cap (`AGENTBOX_CUSTODY_MAX_BLOB_BYTES`, 100 MiB). A hub-side
  `skills.maxSkillBytes` needs the hub to read config, which its routes don't
  do today.
- **Version retention is a constant (newest 5).** Promote to a config key only
  if someone asks.
- **The generic custody PUT routes can write the `skills/` scope directly**
  (`/api/v1/custody/{path}`, `/api/v1/custody/blob/{path}`), bypassing the
  skills name/reserved-prefix checks, and could write `skills/.seeded`. Same
  trust level as the skills routes (API key); refuse `skills/` there and point
  at `/api/v1/skills` when it matters. From the Phase 1 review.
- **The per-PC seeded memo keys hubs by URL.** A local hub that is wiped and
  recreated at the same `http://127.0.0.1:8787` reads as already seeded here;
  `agentbox skills --upload-all` covers it.

- **Phase 2: carried copies still reach boxes.** The plan says to stop seeding
  `~/.agents` and exclude `skills/` from config-volume syncs and static bakes once
  the library is on. Deferred: the shared docker volumes already hold every
  carried skill (the sync is additive, so excluding them from future syncs
  removes nothing), and dropping them for real needs a migration plus a decision
  on boxes that can't reach the library. Until then a library skill and a carried
  copy of the same name can both exist in a box; for claude, the library copy is
  in the managed dir and the carried one in `~/.claude/skills`. Content is
  normally identical (the library was seeded from the same PC).
- **Phase 2: no pinning.** A box's selection is resolved against the library's
  CURRENT versions on every `skills.get` (boot, `agentbox-ctl skills sync`), so a
  restart picks up new versions. Recording the resolved versions on the box and
  showing "behind" is Phase 5.
- **Phase 2: a PC's local relay has no library on a remote-hub setup.** A docker
  box created on a PC registers with that PC's relay, which serves `skills.*`
  from its own custody; with the library on a remote control box, the PC's relay
  answers `library: false` and the box keeps carried skills. Forward `skills.*`
  to the configured hub (the host-reach channel already crosses that boundary).
- **Phase 2: the selection isn't on the hub `Box` payload** (CLI list, web, tray
  can't show it yet; Phase 6 surfaces).
- **Phase 2: only claude is linked** (`AgentSyncSpec.skills` declared for claude
  only). Codex, opencode, pi and openclaw are Phase 3, with their measured
  injection shapes (`/etc/codex/skills`, env, flag, config key).

## From the independent review of PR #434 (2026-11-22)

`/workspace/REVIEW-434.md`. Finding 1 (BLOCKING: the scan missed `.env`-style
secrets) is fixed in the PR. The rest are below.

- **DONE in Phase 2 — was MUST-FIX before skills reach a remote control box:
  symlinks are followed out of the skill tree.** `readSkillTree` (`apps/cli/src/lib/skills/tree.ts`)
  dereferences every link wherever it points, so a skill holding
  `refs -> ~/Projects/app` uploads that checkout (its `.env` included) up to the
  50 MB cap. The plan's Security list says out-of-tree links are rejected; its
  Data-model paragraph says they're resolved on the host. The existing carry
  behaves the same, so not a regression. Fix: resolve a link only when its
  realpath stays under the skill root (or under `~/.agents/skills` /
  `~/.claude/skills` for the usual cross-link); otherwise record a problem.
- **DONE in Phase 2 — was MUST-FIX before skills reach a remote control box:
  the tarball route uses the normal `/api/v1` gate, not custody's elevated byte
  read.**
  `api/v1/skills/[name]/tarball/route.ts`: any holder of the distributed API key
  (tray, thin clients) or a device token can read every skill's bytes. Safe only
  while the PC-side scan is trustworthy and `--allow-findings` is rare. Options:
  a device-scoped read, or the elevated read for versions uploaded with findings
  overridden.
- **The hub trusts the uploader's tree sha and writes the tarball first.**
  `importSkill` `putStream`s to `<meta.sha256>.tar.gz` before reading meta, so an
  upload claiming an existing version's sha with different bytes overwrites the
  good tarball (every download of it then fails the PC-side hash check; nothing
  wrong is installed). Concurrent imports of one skill also race on `meta.json`
  and can drop a version entry / orphan a tarball. Fix: stream to a temp custody
  path and promote, refuse to replace an existing `<sha>.tar.gz` whose bytes
  differ, serialize per-skill meta writes; verifying the tree hash on the hub
  needs a tar reader the hub routes can import.
- **`GET /api/v1/skills` reads every stored tarball in full.** `listSkills` →
  `FsCustodyStore.list` → `readEntry` `readFile`s and hashes each match (up to 5
  versions × N skills, each up to 100 MiB) on every `agentbox skills`, every
  create until the memo is written, and the `/custody` page. Fix: a stat-only /
  streamed-hash listing (`readEntryMeta`).
- **The auto-seed retries on every create when the hub can't answer.** The memo
  is written only after a successful listing; an older hub (404 on
  `/api/v1/skills`) or a no-custody hub (`backend_unavailable`) costs a health +
  list call per create, `health()` has no timeout, and `create-action.ts` passes
  no `debug` so the reason is hidden. Fix: memo `not_found` /
  `backend_unavailable` per hub URL + version, short `timeoutMs` on the seed's
  calls.
- **The download prompt names `r.local.dir`, the write goes to
  `~/.agents/skills/<name>`.** A copy discovered in `~/.codex/skills` or
  `~/.config/opencode/skills` is named in the prompt but left untouched and
  unreported (codex/opencode then see two same-named skills); and when
  `~/.agents/skills/<name>` exists but discovery ignored it (no `SKILL.md`) while a
  different claude copy was discovered, confirming replaces the `~/.agents` dir
  the prompt never named. Fix: prompt with the actual target and report every
  other location left in place (`alsoAt` has them).
- **Description over 2048 chars** is rejected by the hub and not truncated by
  the CLI, so such a skill shows as `failed` in the seed (the spec caps 1024).
- **Case collisions:** on a case-insensitive FS a tarball with both `a.md` and
  `A.md` passes the tree-hash check but only one file lands.
- **Phase 2:** the hub never validates tarball contents; the zip-slip / symlink
  guard is only the CLI's `readTar`. The box-side materializer must reuse it (or
  an equivalent), never `tar -x`.
- **Seed latency:** the first-create seed reads every local skill into memory and
  uploads inline before the create continues, with no spinner.
- **The `.npmrc` name rule flags registry-only files** (seen in four plugin
  folders in this owner's `~/.claude/plugins`; plugins aren't seeded). A skill
  shipping a registry-only `.npmrc` gets a confirm; narrowing it to files holding
  `_auth` / `_authToken` would remove that.

## From the Phase 1b `/code-review medium` (2026-11-22)

The first draft's design (folding the digest into the shared fingerprint, with
a hub-set `AGENTBOX_SKILLS_DIGEST` override) was replaced, which resolved the
review's findings 1, 2 (a regression: remote-hub bakes no longer adopted by a
PC with skills), 3, 5 and 6 outright, and 7 (a transient discovery failure
cached as "no skills": the memo now keeps only successful reads, and a failed
stamp records nothing). Still open:

- **The digest counts only library-eligible skills, but the bake stages every
  skill.** Editing or removing a skill the scan flags (or one over the size cap)
  doesn't mark the base stale, and a PC bake containing a flagged skill passes
  the library gate when its eligible set matches. Not a regression (bake sharing
  adopted everything before). Fix with a second, full-set digest for staleness.
- **Per-agent bakes are judged against every agent's skill dirs.** A codex skill
  edit marks a claude-only derived snapshot stale (over-reports, never
  under-reports). Fix by digesting only the dirs the variant stages.
- **The control box's worker-side adoption isn't library-gated.**
  `_run-queued-prepare` → `tryAdoptPreparedBase` can still adopt a PC's shared
  record on the control box without comparing skills to the library, exactly as
  before this phase. Gate it the same way (it needs the library digest, which
  the worker can read from its own custody).
- **Freshness re-runs discovery once the 30 s memo expires**, reading and
  scanning every skill on the hub's provider-freshness path and the CLI's
  create path. A stat-based change key (mtime/size) gating rediscovery would
  remove the repeated I/O.
- **`@madarco/agentbox-provider-sdk` is not republished.** sandbox-core gained
  exports and `PreparedBaseSnapshot.base` two optional fields; nothing an
  existing plugin uses changed, so a stale SDK only means community providers
  don't record skills (and are never judged on them). Republish per
  `docs/provider-plugins.md` when convenient.
- **The hub's bake diff can't explain a skills-only stale verdict** — it diffs
  build-context files, so the System page shows the reason string but an empty
  file diff.

## From the second Phase 1b `/code-review medium` (2026-11-22)

Fixed in the PR: the library gate removed (finding 1, a regression — see plan
item 4; that also removes findings 4 and 7); daytona's variant rebuild message
named the base's context instead of the variant's (6); the bake stamp read the
30 s freshness memo, so a record could carry an older digest than the skills it
staged (8); the digest test leaked temp dirs (10). Still open:

- **A control box's base never goes stale on library changes.** Its home has no
  skills, so its records stamp `''` and compare against `''`. Becomes real once
  the library is delivered to boxes (Phase 2), which is also when the control
  box should judge staleness against the library.
- **A PC that adopts a control box's shared bake is never judged on skills.**
  The record carries the control box's `skillsHost`, so the PC never reports it
  stale and boxes lack the PC's skills until a `--force` bake. Same as before
  this phase (adoption ignored skills); resolved by Phase 2's delivery.
- **Only the agentless `base` record is checked for skills staleness.** A
  derived variant (e.g. claude) keeps its old digest and snapshot after the base
  re-bakes, and skills deleted on the host survive in it (the tar overlay never
  removes files). Check variant records too, and re-bake the variant a create
  actually boots.

## From the independent review of PR #438 (2026-11-22)

`/workspace/REVIEW-438.md`: no blocking findings, no regressions. L2 (the stale-
base prompt now names the reason, e.g. "host skills changed since this base was
baked", and says Yes starts without the default checkpoint) and L3 (the bake
digest ignores `__pycache__`, `node_modules`, `.venv`/`venv`, caches and `*.pyc`
a skill writes into its own folder; the library tree hash is unchanged) are
fixed in the PR. Still open:

- **L1. The System page mis-explains a skills-only stale base.** The bake diff
  finds no changed build-context file and says the difference is "in how the
  fingerprint was folded (e.g. a different bake-affecting agent setting)",
  hiding the real reason. Fix: in `StaleDiff`
  (`apps/hub/app/(dashboard)/system/page.tsx`), show `baseStaleReason` when the
  diff is empty, or skip `providerBakeDiff` for the skills reason.
- **L4. A variant `prepare` re-bakes for skills in other agents' folders** (the
  digest covers all six skill dirs; a claude variant stages only claude's config
  plus `~/.agents`). Costs time on an explicit prepare only. Same item as the
  per-agent note above: digest only the dirs the variant stages.
- **L5. Provider SDK not republished** — additive change; see the SDK note above.

## From the Phase 2 `/code-review medium` (2026-11-22)

Fixed in the PR: the control-box worker (`hub-worker.ts`) and the docker
provider adapter (`DockerProvider.create`) dropped the skill selection; the
daemon's sync had no `.catch` and the pass could throw (an unhandled rejection
kills ctl) — the pass now never throws and the call is caught; the CLI surface
fixture; skill names are validated at the flag (an invalid one used to vanish
in the relay and leave a box with zero skills); a duplicated parse; a misplaced
doc comment; stale flag names in comments. Still open:

- **Each `skills.blob` chunk re-resolves the box's set** (lists the scope and
  reads every selected skill's `meta.json`) to authorize one 512 KiB slice.
  Fine for typical skills; a 50 MB skill is ~100 chunks. Authorize once per
  download (e.g. a short-lived per-box resolved-set cache in the relay).
- **No lock between the boot-time sync and `agentbox-ctl skills sync`.** Staging
  dirs are now unique per pass, so neither clobbers the other's half-written
  tree, but both rewrite `.manifest.json` and the last writer wins. Take a lock
  file in the library dir.

## From the independent review of PR #441 (2026-11-22)

`/workspace/REVIEW-441.md`. Fixed in the PR: B1 (the ctl
`agent-registry-fetch` expectations lacked the new `skillDirs`, CI red) and B2
(`sanctionBranch` re-registered a docker box without its skill selection, so a
host branch switch widened a `--no-skills` / `--skip-skills` box to the whole
library; the hosted plane's own register handler now carries it too). R1 is
accepted as intended: `GET /api/v1/skills/{name}/tarball` takes custody's
elevated read, so a PC holding only the hub API key can list but not download
(documented on the public skills page). Still open:

- **L1. Every `skills.get` and `skills.blob` chunk reads and hashes the whole
  `skills/` scope.** `resolveBoxSkills` → `custody.list('skills')` →
  `FsCustodyStore.list` `readFile`s and sha256s every stored tarball of every
  version, per chunk, on the hub's event loop: ~(chunks + 1) × library bytes per
  box boot. Harmless for KB-sized skills. Fix: check `.seeded` with a `get`,
  enumerate names without hashing, cache the resolved set per box for a pass
  (supersedes the per-chunk note above).
- **L2. `sudo -n install -d -o <vscode>` chowns an existing root-owned dir.** The
  path comes from `agents.list`, which includes `agentbox agent add` agents. No
  new boundary (vscode has passwordless sudo; plugin recipes run as root), and
  for claude the dir never exists beforehand. Harden: sudo-create only when
  missing, never chown an existing dir, optionally allowlist the prefix.
- **L3. The manifest is written only at the end of a pass.** If a `symlink()` or
  `rm` throws halfway, skills installed in that pass go unrecorded and become
  orphan trees/links later removal never deletes. Write it in a `finally`, or
  after each step.
- **L4. Manifest keys aren't re-checked against the name rule** before
  `rm(join(root, name), {recursive})`. Only a same-user (vscode) tamper reaches
  it; cheap belt-and-braces.
- **L5. On a cloud box with the host off, `skills.get` parks on
  `HostActionQueue`.** ctl gives up after 60 s, but the queue slot and socket
  stay open (the same leak as `agents.list`).
- **L6. `readSkillTree` now skips out-of-tree link targets**, so the cloud-bake
  skills digest misses edits to a linked file, and such skills are blocked from
  upload and the auto-seed (the host carry still delivers them).
- **L7. Find the elevated token per target URL.** `agentbox skills` takes the
  admin token from `resolveCustodyTarget`, which returns nothing for a hub
  exposed on this Mac after `hub unset-url`, so that download 401s. Use
  `hubBearerFor(<target url>, 'admin', …)`, which also ties the token to the hub
  that issued it.
- **L8. A new ctl against an old hub appends an `rpc-unknown` event on every
  boot** and logs "skills.get failed". Cosmetic.
- **L9. Claude's inject dir is in every box's descriptor whatever the box's
  agent** (not `runsHere`-gated), so a codex-only box still sudo-creates
  `/etc/claude-code/.claude/skills` and installs the set. Harmless.

## From the Phase 3 `/code-review medium` (2026-11-22)

Fixed in the PR: opencode's injection moved from `OPENCODE_CONFIG_CONTENT` to a
`dir` link (it replaced the user's `skills.paths` and never reached opencode on
Hetzner/DigitalOcean, see Phase 3 item 3); `agentLaunchFlags` ignores a malformed
plugin `flag` injection instead of failing every launch.

Later:

- **Pre-existing: opencode's run env never reaches a Hetzner/DigitalOcean box.**
  `cloudInitBoxEnv` keeps only `AGENTBOX_*` keys and the cloud launcher exports
  only `agentTuiEnv`, so `OPENCODE_CONFIG_DIR` / `XDG_STATE_HOME` (and any other
  `boxRunEnv`) are missing there. Not a skills issue any more, but the same gap.
  Fix: export the agent's `boxRunEnv` on the launch command in
  `buildCloudAttachInnerCommand`, like the docker path.
- **`BOX_SKILLS_LIBRARY_DIR` is a fixed `/home/vscode/...` path** (it was
  `homedir()` in Phase 2), because host-side `{dir}` expansion needs one known
  path. On a provider whose execs run as root (islo), ctl writes it as root, and
  a later ctl run as vscode can't update it. Fix with the islo provider work:
  chown the tree to the box user, or have ctl always run as vscode.
- **openclaw's `config` declaration is not read by anything generic**: the boot
  script hardcodes `skills.load.extraDirs`. A plugin agent declaring `config`
  gets nothing. Either read `jsonPath` in the task, or document `config` as
  "the agent's own boot task does it".
- **The openclaw merge passes the skill dirs as one `:`-joined argv.** Both are
  constants without `:` today; pass them as separate args or JSON if either
  becomes configurable.
- **ctl's startup skills sync doesn't retry.** It runs once, after the
  `agents.list` fetch; when the same command cold-starts the hub, that fetch hits
  ECONNREFUSED and the box gets no library skills until `agentbox-ctl skills sync`
  (seen in the Phase 3 live check; a box created with the hub already up synced at
  start). Fix: retry the fetch with backoff, or sync on the first successful
  relay call.
- **Duplicate names in pi and openclaw**: the carried `~/.agents` copy wins over
  the library's, so a skill edited in the library isn't seen there while the
  PC's old copy is carried. Same fix as the carry-exclusion item.

## From the independent review of PR #445 (2026-11-23)

Fixed in the PR: R1, pi's missing `--skill` dir warning (see the Phase 3 plan
note above).

Later:

- **L1: the startup skills sync is non-blocking** (`packages/ctl/src/commands/daemon.ts`,
  the `void syncBoxSkills(...)` after `agents.list`). pi and codex can start
  before it finishes, and miss library skills until they restart. Related to the
  no-retry item above.
- **L2: with a library, every box creates `/etc/codex/skills` and
  `~/.opencode/skills`** whatever its agent, because ctl links into every `dir`
  injection the descriptors declare. Harmless (empty of anything but links).
- **L3: the published SDK's `resolveAgentSpec` return type gained two inject
  kinds** (`flag`, `config`). Additive; ships with the next SDK republish, no
  `SDK_API_VERSION` bump.
