# Settings sync across boxes + automatic credential fan-out — implementation plan

Status: **Phase 0 done (2026-07-09) — Phase 1 next**. One session per phase; update the
status line and the per-phase checkboxes as work lands.

## Context

Two related gaps:

1. **Settings installed inside a box don't reach other boxes.**
   `agentbox download claude|codex|opencode [box]` already does the box→host half
   (additive pull of skills/plugins/agents/commands into host `~/.claude` etc.) — but it
   is **docker-only** (reads the docker config volume via `pullClaudeExtras`; a cloud box
   ref silently falls back to the shared docker volume, which is wrong) and there is
   **no propagate step** to push the pulled settings to other live boxes
   ("same project / all").

2. **Claude OAuth refresh-token rotation breaks all other copies.** When in-box Claude
   refreshes its access token, the refresh token rotates and every other copy of the
   *box* credential blob (host backup `~/.agentbox/claude-credentials.json`, the shared
   docker volume, other cloud boxes' `~/.claude/.credentials.json`) becomes invalid →
   401. Nothing detects this today; the backup is only refreshed pre-cloud-create
   (expiry-gated `refreshAgentCredentialsBackup`) and on `checkpoint --set-default`.
   `resume()` never re-pushes credentials, so a box unpaused after a rotation elsewhere
   wakes up with a dead token.

Decisions:

- Extend the existing `agentbox download <agent>` commands (no new command group).
- Host `~/.claude` writes stay behind the existing confirmation prompt; propagation to
  boxes must work even if the host write is declined (propagate from the pulled temp
  tree).
- Automatic fan-out covers **all three agents**: claude via `claudeAiOauth.expiresAt`
  newest-wins; codex/opencode via content-change, last-writer-wins.
- All five providers: docker + daytona + hetzner + vercel + e2b.

## Phase 0 — empirical PoCs

Validate the load-bearing assumptions before building. Run 2026-07-09 on the live
docker box `agentbox-test-repo-gh-ba1e38b65` (whose access token had expired
naturally, so a plain `claude -p` turn forced a real refresh):

- [x] **Rotation comparator** — confirmed. The refresh rotated BOTH `accessToken` and
      `refreshToken`, and `claudeAiOauth.expiresAt` moved strictly forward (+19.3h).
      `expiresAt` newest-wins is a valid comparator.
- [x] **Old-refresh-token invalidation** — confirmed. A saved copy of the pre-refresh
      blob (with `expiresAt` in the past, in a throwaway `$HOME`) got
      `Not logged in · Please run /login`, exit 1: the refresh token is single-use;
      rotation kills every other copy. Notably the host backup
      `~/.agentbox/claude-credentials.json` was byte-identical to the pre-refresh blob
      before the test — i.e. the bug reproduced exactly (the backup died the moment the
      box refreshed); it was manually re-synced from the post-refresh blob, which is
      precisely what the fan-out automates.
- [ ] **Live-session re-read** — OPEN (cannot be forced without waiting out a real
      access-token expiry inside a running session). Design assumes the worst case: a
      long-running session may hold a stale refresh token in memory and 401 once even
      after fan-out fixed the file; a session restart picks up the fresh blob. Document
      this in the user docs; observe in practice during Phase 7 verification.
- [x] **Paused docker box + isolated volume** — confirmed. A helper container wrote a
      marker into `agentbox-claude-config` while the box was paused; the file was
      visible in-box after unpause. Fan-out never needs to skip a docker box.
- [x] **Watcher mechanism** — decided: mtime/hash polling in ctl (15s), not `fs.watch`
      (credential writes are atomic renames; inotify on the renamed path is unreliable).

## Phase 1 — pull refactor (merge core out of sandbox-docker)

- Split `pullClaudeExtras` (`packages/sandbox-docker/src/sync/agents/claude.ts`) into
  the **inventory + additive host-merge core** and the **source reader**. Move the merge
  core to `packages/sandbox-core/src/sync/`; sources are (a) docker volume via
  throwaway container (existing), (b) a local pulled directory (new, for cloud). Same
  split for the codex/opencode pulls. Existing sandbox-docker exports stay as thin
  wrappers.
- Pure vitest coverage for the merge core: additive semantics (existing host items never
  overwritten), plugin-registry JSON merge.

## Phase 2 — cloud pull support in `download claude|codex|opencode`

- `apps/cli/src/commands/download-{claude,codex,opencode}.ts`: when
  `box.provider !== 'docker'`, pull the agent-config categories (per
  `AGENT_SYNC_SPECS.staticPaths`) from the live box FS into a temp dir via the cloud
  SyncTransport (`pullTree`, `packages/sandbox-cloud/src/sync/sync-transport.ts`), then
  run the local-dir merge core. Box must be running (offer resume, same pattern as
  `download`).

## Phase 3 — propagate step

- After the pull (keep the pulled temp tree even when the host write is declined):
  prompt `Propagate to other boxes? → same project / all boxes / no`
  (clack `select`; flags `--propagate <project|all|none>`, existing `-y`).
- Targets = `readState().boxes` minus the source box (project filter for `project`):
  - docker shared volume: one additive seed into `agentbox-claude-config` covers every
    shared-volume docker box (running or paused) — run once, not per box.
  - docker isolated volume (`box.claudeConfigVolume`): same seed per volume.
  - cloud running: push exactly the pulled new items + merged registries via
    `pushTree`/`pushFile` (owner via `id -un`, never hardcoded 1000).
  - cloud paused/stopped: skip with a printed note.
- Per-target result summary. Vitest: target enumeration (project filter, skip source,
  skip stopped cloud, shared-volume dedup).

## Phase 4 — config key + ctl credential watcher

- `box.credentialSync` (boolean, default `true`) typed key in `@agentbox/config` +
  `--no-credential-sync` create flag; wired into the box as env
  `AGENTBOX_CREDENTIAL_SYNC` (internal wire only).
- New ctl concern: poll every 15s (stat mtime → sha256 on change) the credential files
  `~/.claude/.credentials.json`, `~/.codex/auth.json`,
  `~/.local/share/opencode/auth.json`. Paths are ctl-side constants with a **drift
  test** against `AGENT_SYNC_SPECS` (`packages/sandbox-core/src/sync/registry.ts`).
- On change + shape-valid, POST `POST /rpc { method: 'credentials.updated', params:
  { agent, contentBase64, capturedAt } }` via `packages/ctl/src/relay-client.ts`.
  Best-effort, never crashes the supervisor.

## Phase 5 — relay handler + hidden propagate CLI

- `packages/relay/src/credentials-rpc.ts`, dispatched from `server.ts`:
  - validate shape (`isRealAgentCredential`,
    `packages/sandbox-core/src/sync/concerns/credentials.ts`);
  - newest-wins: claude → accept only if incoming `expiresAt` > host backup's;
    codex/opencode → accept if content differs;
  - write host backup atomically, mode 0600;
  - debounce per agent (~3s) + single in-flight fan-out with latest-wins queuing;
  - fan-out by spawning the host CLI (same pattern as `checkpoint.create`):
    `agentbox credentials propagate --agent <a> --source-box <id>`. No approval prompt
    (host-policy distribution of the user's own credentials, not a box-initiated host
    action).
- New hidden `apps/cli/src/commands/credentials.ts` (`credentials propagate`):
  enumerate `state.boxes`, skip source + non-running; docker → existing volume
  credential sync (shared once + each isolated volume); cloud running → `pushFile` the
  backup to `credential.boxAbsPath`, 0600, owner `id -un`. Also usable manually for
  recovery.
- Vitest: comparator, debounce, latest-wins queue, reject-stale.

## Phase 6 — resume/start reconcile (cloud only)

- `packages/sandbox-cloud/src/cloud-provider.ts` `resume()` (+ cloud `start()` path):
  after `reEnsureCloudBox`, run `reconcileAgentCredentials(backend, handle)`:
  - claude: compare `expiresAt` both directions — host newer → `pushFile`; box newer →
    write host backup + spawn the propagate command;
  - codex/opencode: host-wins on resume (box was frozen) — push if content differs.
- Best-effort: reconcile failure must not fail `resume`. Docker resume needs nothing
  (volumes are updated live by fan-out even while paused).

## Phase 7 — docs, re-prepare, end-to-end verification

- Public docs (`apps/web/content/docs`): `download <agent>` reference (cloud support +
  `--propagate`), "credential sync across boxes" section, `credentialSync` config key.
- Repo docs: `docs/features.md`, `docs/host-relay.md` (new RPC),
  `docs/in-box-supervisor.md` (watcher), `docs/cloud-providers.md` (resume reconcile).
- Rebuild ctl + relay, **restart the relay**, re-stage runtime assets; re-run
  `agentbox prepare --provider <p>` per cloud provider (new ctl must be baked — same
  class of issue as the hetzner relay-env regression). Existing boxes lack the watcher
  until recreated; resume reconcile + the manual command cover them.
- Manual verification:
  - Feature 1: install a skill inside a docker box and a cloud box →
    `agentbox download claude <box>` → additive host merge → propagate to `project` →
    skill visible in a second docker box and a running vercel/e2b box.
  - Feature 2: bump `expiresAt` in a box's `.credentials.json` → within ~20s host
    backup updates (0600) and other running boxes match (`~/.agentbox/relay.log`).
    Pause a cloud box, rotate on host, `agentbox resume` → box matches backup. Verify
    with a real logged-in `claude -p` turn in a target box (box-usable-not-just-ready),
    across docker + one snapshot cloud + e2b.

## Notes

- No `Provider` interface change → no provider-SDK republish expected; re-check the SDK
  re-export surface before shipping (the sandbox-core merge-core addition is additive).
- apps/cli tests touching `~/.agentbox` must isolate `$HOME` per file.
