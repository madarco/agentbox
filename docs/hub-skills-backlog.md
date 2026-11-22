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
- **The hub trusts the uploader's tree hash.** `importSkill` stores the tarball
  under the client-stated `sha256` and records its size and file count as
  stated. Verification happens on download (the PC re-derives the hash and
  refuses a mismatch), so a bad upload can't install the wrong files anywhere,
  but it can overwrite another version's tarball and make that version
  undownloadable. Verifying on the hub means parsing the tarball there (a
  pure-JS reader like the CLI's, shared through a package the hub routes can
  import). From the Phase 1 review; the uploader is an authenticated owner.
- **`meta.json` is read-modify-write without a lock.** Two concurrent uploads of
  the same skill can drop one version entry and orphan its tarball. Rare (one
  owner, uploads are explicit, the seed runs once per hub); needs a per-skill
  lock or compare-and-swap in custody. From the Phase 1 review.
- **The generic custody PUT routes can write the `skills/` scope directly**
  (`/api/v1/custody/{path}`, `/api/v1/custody/blob/{path}`), bypassing the
  skills name/reserved-prefix checks, and could write `skills/.seeded`. Same
  trust level as the skills routes (API key); refuse `skills/` there and point
  at `/api/v1/skills` when it matters. From the Phase 1 review.
- **The per-PC seeded memo keys hubs by URL.** A local hub that is wiped and
  recreated at the same `http://127.0.0.1:8787` reads as already seeded here;
  `agentbox skills --upload-all` covers it.
