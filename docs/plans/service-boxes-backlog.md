# Persistent boxes & service agents — backlog

Minor / deferred items found while implementing `service-boxes-plan.md`. Each phase appends
here rather than sidequesting. Promote an item to the plan if it turns out to be load-bearing.

## From Phase 0 (openclaw PoC, 2026-09-02)

- **`--allow-scripts=openclaw` leaves four dependency install scripts unrun** — `koffi` (native
  FFI), `tree-sitter-bash` (node-gyp-build), `protobufjs`, `@google/genai`. openclaw installs and
  serves anyway, but a feature routed through those deps may be silently degraded. Decide whether
  to broaden the allowlist once a real channel is exercised.
- **openclaw is 893 MB installed.** If we ever want a baked variant, measure the pull cost first;
  on-demand install is the default for good reason.
- **Channel pairing is unverified.** `openclaw channels add --use-env` and *which* dirs a pairing
  needs to survive a restart both need a real credential. Do it when a channel is first wired.
- **`~/.config/openclaw` is empty after onboard.** It is persisted on the assumption it holds the
  auth-profile encryption key; confirm when auth profiles are actually used.

## From Phase 7 (deferred, needs real money / shared state)

- Re-run the base bake for the VPS providers after the openclaw row lands:
  `agentbox prepare --provider hetzner` and `agentbox prepare --provider digitalocean`.
  Watch for the `box.image` cross-provider collision (`agentbox config unset box.image --project`
  to recover).

## From Phases 4-5 (workspace sync + clone, 2026-09-02)

- **The NUL-termination bug was live in BOTH resync implementations.** `probeUntrackedTokens` fed
  the box `paths.join('\0')` in `packages/sandbox-cloud/src/sync/workspace-resync.ts` *and* in
  `packages/sandbox-docker/src/sync/in-box-git.ts`, but `read -r -d ''` treats an unterminated tail
  as EOF — so the LAST untracked path was never probed, came back as "absent in the box", and was
  overwritten by the host's version on every session-start resync. Reproduced live on docker
  (`agentbox sync` silently clobbered the box's `shared.txt`) and fixed in both; pinned by
  `packages/sandbox-core/test/box-files.test.ts` and
  `packages/sandbox-docker/test/resync-probe-nul.test.ts`. Worth a look for other `join('\0')`
  payloads.
- **Every box-side path list is now chunked; watch for new ones.** A list encoded into a single
  `printf` argument is capped by Linux `MAX_ARG_STRLEN` (128 KiB), which a normal repo exceeds — a
  9001-file workspace produced a 456 KB argument and `docker exec` refused it with
  `Argument list too long`. `chunkPathsForExec` (`packages/sandbox-core/src/sync/concerns/box-files.ts`)
  is the shared budget; `pullTar` creates with `tar -cf` and appends the rest with `-rf`. Any new
  box-side payload built the same way needs the same treatment.
- **Empty directories are not carried in exclude-list mode.** The selection is a file list
  (`find … -type f -o -type l`), and `rsync --files-from` only creates the parent dirs it needs. A
  workspace that depends on an empty `uploads/` existing gets it back only once it has a file. Fix
  by emitting `-type d -empty` entries if a real workload hits it.
- **`clone` of a git-backed box drops `.git`.** By design — the clone is a template, and a
  git-backed second box on the same project is a plain `agentbox create`. If a "second checkout with
  the box's uncommitted work" is ever wanted, it is a different feature: create normally, then
  overlay the export.
- **`clone` creates the new box with no agent (`agent: 'none'`).** Carrying the source box's agent
  id would mount that agent's SHARED config volume and credential, which is precisely what the
  fresh-identity contract forbids; giving the clone its own isolated volume needs an isolate override
  on the hub create input, which is create-path plumbing this phase does not own. Harmless for the
  plan's consumers — openclaw/t3code/hermes are ctl services declared in the `agentbox.yaml` that
  travels with the workspace — but a `clone` of a `claude` box today yields an agentless box. Fix
  alongside Phase 2, when `caps.surface === 'service'` already derives `isolate`.
- **`sync` has no `--dry-run`.** `download` does, and the machinery (hash + probe + classify) already
  computes the full plan before writing anything, so it is a flag and a return path away.
- **`agentbox sync` runs inline in the CLI, not through the hub.** The hub route exists
  (`POST /api/v1/boxes/:id/sync`) and the web UI/tray can use it, but the CLI calls the shared
  concern directly — same as `download` does today. Routing both through the hub client is the
  `docs/hub-api-single-path-plan.md` cleanup, not a Phase-4 one.
- **Exclude-list mode hides a project-level `.claude/`.** The agent state excludes are derived from
  the registry's `staticPaths`, so `.claude` is dropped in exclude-list mode — right for a service
  box whose agent writes state there, wrong for a non-git project that keeps its skills in
  `.claude/`. Gitignore mode is unaffected (that is why `dropExcludedInGitMode` is opt-in and only
  `clone` sets it). Revisit if someone hits it; an `--include <glob>` carve-in is the obvious answer.
- **remote-docker and digitalocean were not exercised.** The plan calls out remote-docker as the main
  consumer of the non-git leg. The code path is provider-neutral (`BoxFilePorts` over
  `exec`/`uploadPath`/`downloadPath`, which both implement) and docker + the hub routes were verified
  live, but neither VPS provider was run.
