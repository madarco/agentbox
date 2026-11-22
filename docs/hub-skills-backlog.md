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

## Phase 1b — implementation plan (2026-11-22)

Scope: the hub web Skills page (list + discard), the System page swap, and a
skills digest folded into the cloud base fingerprint.

1. **Skills digest.** sha256 over sorted `<name>:<treeSha>` lines of the skills
   the first seed would upload (discoverable, valid, no scan findings), so a PC's
   digest equals the library's when they hold the same skills. An empty set
   folds nothing (`variantFingerprint` unchanged), so a user with no skills sees
   no fingerprint change. The pure discovery/tree/scan/frontmatter modules move
   from `apps/cli/src/lib/skills/` into `@agentbox/sandbox-core` so the providers
   can compute it.
2. **Where it folds.** `variantFingerprint` gains an optional `skills` input. The
   five providers whose bakes stage host static config (daytona, hetzner,
   vercel, e2b, digitalocean) pass `bakeSkillsDigest()` in `prepare` (so
   skip-fast rebuilds on a skills change) and in their live base fingerprint (so
   `prepare`/create/hub report the base stale). Docker and remote-docker don't
   bake host config and are untouched.
3. **Which skills count — the source rule.** `bakeSkillsDigest()` uses this
   machine's own skills, unless `AGENTBOX_SKILLS_DIGEST` is set. The hub sets it
   to the LIBRARY digest only when its own machine has no eligible skills and the
   library is seeded, i.e. a deployed control box. Why not "always the library":
   on a PC (local hub, or `hub expose` on the laptop) the CLI and the hub share
   one prepared-state, and the bake stages from that home, so both must use the
   home. Why not "always local": a VPS has no skills, so it would refuse every PC
   bake that carries skills and re-bake without them. With the rule, a VPS
   adopts a PC bake exactly when its skills match the library, and re-bakes
   otherwise. The hub refreshes the variable at start and after every skills
   import/discard; its bake workers inherit it.
4. **Web.** `/skills` page in the hub (pure `/api/v1` client): name,
   description, size, files, source PC, updated, versions; discard with a
   confirm. Sidebar entry. The System page's "Skills · this control box" section
   becomes a library summary linking to `/skills`.
5. **Docs.** Public skills page (web UI + stale bases), deployed-hub web UI
   list; plan status.

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

## From the independent review of PR #434 (2026-11-22)

`/workspace/REVIEW-434.md`. Finding 1 (BLOCKING: the scan missed `.env`-style
secrets) is fixed in the PR. The rest are below.

- **MUST-FIX before skills reach a remote control box: symlinks are followed
  out of the skill tree.** `readSkillTree` (`apps/cli/src/lib/skills/tree.ts`)
  dereferences every link wherever it points, so a skill holding
  `refs -> ~/Projects/app` uploads that checkout (its `.env` included) up to the
  50 MB cap. The plan's Security list says out-of-tree links are rejected; its
  Data-model paragraph says they're resolved on the host. The existing carry
  behaves the same, so not a regression. Fix: resolve a link only when its
  realpath stays under the skill root (or under `~/.agents/skills` /
  `~/.claude/skills` for the usual cross-link); otherwise record a problem.
- **MUST-FIX before skills reach a remote control box: the tarball route uses
  the normal `/api/v1` gate, not custody's elevated byte read.**
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
