# Seed the current project's Claude memory into every box (rekeyed to /workspace)

## Context

Verification found that Claude Code's per-project memory never reaches a box:
the cloud snapshot excludes `projects/` entirely, and docker copies `projects/`
under the **host** path key while the in-box Claude (cwd `/workspace`) reads the
`-workspace` key — so the keys never line up. Codex global memories already
sync; OpenCode has no file memory. (Full findings retained below.)

Fix (this plan): at box create, migrate **only the current project's `memory/`
directory** — not sessions — into the box, **rekeyed/rehashed** from the host
cwd to `/workspace`. This mirrors the rekey we already do for the trust-workspace
alias in `_claude.json` (`addProjectAlias(working, hostWorkspace, '/workspace')`).
Implemented symmetrically across docker + cloud (daytona/hetzner).

Host: `~/.claude/projects/<encode(hostCwd)>/memory/`
Box:  `/home/vscode/.claude/projects/-workspace/memory/`
where `encode(p) = p.replace(/[^a-zA-Z0-9]/g, '-')` and `/workspace` → `-workspace`.

## Implementation

### 1. Shared resolver — `packages/sandbox-docker/src/host-stage.ts`

Add (host-stage already imports `homedir`, `join`, `pathExists`, `readdir`):

- `const BOX_CLAUDE_PROJECT_DIR = '/home/vscode/.claude/projects/-workspace';`
  (the `-workspace` encoding is fixed for every box, matching the existing
  hardcoded `CLOUD_WORKSPACE = '/workspace'` at line 53.)
- `export function encodeClaudeProjectsKey(absPath: string): string` →
  `absPath.replace(/[^a-zA-Z0-9]/g, '-')` (same rule as
  `apps/cli/src/session-teleport/cwd-encoding.ts`; duplicated with a comment
  because host-stage must not depend on `apps/cli`).
- `export async function resolveClaudeMemoryDir(hostWorkspace: string, hostHome = homedir()): Promise<string | null>`
  — returns the host `…/projects/<encodeClaudeProjectsKey(hostWorkspace)>/memory`
  dir, or `null` when it's absent or empty (so callers no-op).

Export all three from the package index so `@agentbox/sandbox-cloud` can import them.

### 2. Docker — `packages/sandbox-docker/src/claude.ts` (`ensureClaudeVolume`)

The box container isn't running at create time; the volume is populated by the
throwaway helper container that mounts host `~/.claude` at `/src-claude` and
rsyncs into `/dst`. Two edits inside that helper's `sh -c` (around lines 315–362):

- **Stop leaking host-keyed projects/sessions into the shared volume**: add
  `--exclude=projects` to `rsyncExcludes` (line 315), matching cloud's
  `CLAUDE_RUNTIME_EXCLUDES`. Box-written `-workspace` sessions are untouched
  (rsync has no `--delete`); session-teleport (`-c`/`--resume`) still uploads
  its single jsonl directly to the running box, so continuity is preserved.
- **Re-add only the rekeyed memory**: when `opts.hostWorkspace` is set, compute
  `const key = encodeClaudeProjectsKey(opts.hostWorkspace)` in JS (result is
  `[A-Za-z0-9-]` only → shell-safe) and append a step after the rsync:
  ```
  && { [ -d "/src-claude/projects/<key>/memory" ] \
       && mkdir -p /dst/projects/-workspace \
       && rm -rf /dst/projects/-workspace/memory \
       && cp -a "/src-claude/projects/<key>/memory" /dst/projects/-workspace/memory; true; }
  ```
  The existing trailing `chown -R 1000:1000 /dst` (line 362) covers it. Log a
  line (e.g. `seeded claude memory for <workspace> -> /workspace`) when the dir
  was present, via a flag returned from `ensureClaudeVolume`.

### 3. Cloud — `packages/sandbox-cloud/src/cloud-provider.ts` (`create`)

Cloud's static snapshot excludes `projects/` and is built per-org at prepare
time, so memory must be uploaded per-box at create. After
`seedOpencodeModelState(...)` (~line 381), in the **non-snapshot** branch only
(`if (!snapshotName)` — a checkpoint/snapshot boot already carries the source
box's memory and must not be clobbered), add a best-effort block:
```ts
const memDir = await resolveClaudeMemoryDir(req.workspacePath);
if (memDir) {
  try {
    await uploadToCloudBox(backend, handle, memDir, `${BOX_CLAUDE_PROJECT_DIR}/`);
    log(`seeded claude memory for ${req.workspacePath} -> ${BOX_CLAUDE_PROJECT_DIR}/memory`);
  } catch (err) {
    log(`claude memory seed skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
```
The trailing slash makes `uploadToCloudBox` land the source under its basename →
`…/projects/-workspace/memory/…`, chowned to uid 1000 (same as the docker side).

### Notes / scope

- **Only `memory/` is migrated; sessions are not.** Under the box's `-workspace`
  key, the only project state seeded from the host is `memory/` (incl.
  `MEMORY.md`). Sessions arrive only via the existing teleport on `-c`/`--resume`.
- **Codex / OpenCode: no change** (verified). Codex `~/.codex/memories/` is
  global and already synced on both docker and cloud; OpenCode has no file memory.
- **Edge cases**: no host memory dir or empty dir → silent no-op; box already has
  memory → `cp -a` after `rm -rf` (docker) / `tar -xf` overwrite (cloud) makes the
  host authoritative; failures are best-effort and never fail box creation.
- **Docker shared volume**: still last-writer-wins for the `-workspace` key (same
  semantics as the existing `_claude.json` project alias); `--isolate-claude-config`
  gives per-box memory with zero extra code.

## Verification

1. Build: `pnpm -w build` (or the affected packages).
2. Docker: `node apps/cli/dist/index.js create -y -n memtest` in this repo, then
   - `docker exec agentbox-memtest ls -la /home/vscode/.claude/projects/-workspace/memory/`
     → lists `MEMORY.md` + the `.md` files, owned by `vscode`.
   - `docker exec agentbox-memtest ls /home/vscode/.claude/projects/ | grep -i users`
     → host-keyed dir is **absent** (sessions no longer leaked).
3. Negative: create a box for a project with no memory → no seed log line, in-box
   memory dir absent, create still succeeds.
4. Codex unchanged: `docker exec agentbox-memtest ls /home/vscode/.codex/memories/`.
5. Cloud (optional, if testing daytona/hetzner): `agentbox create --provider hetzner -y -n memtest`,
   then check `/home/vscode/.claude/projects/-workspace/memory/` over the box shell.
6. `pnpm lint` + any affected `vitest`.

---

## Original verification findings (reference)

| Agent | Memory location (host) | Reached box before fix? |
|-------|------------------------|-------------------------|
| Claude | `~/.claude/projects/<host-cwd>/memory/` | No — cloud excluded `projects/`; docker keyed to host path, not `/workspace` |
| Codex | `~/.codex/memories/` (global) | Yes — not in any exclude list |
| OpenCode | none (SQLite `opencode.db` / `storage/`) | N/A — no file memory |

Key files: `packages/sandbox-docker/src/host-stage.ts` (`CLAUDE_RUNTIME_EXCLUDES`
line 159), `packages/sandbox-docker/src/claude.ts` (`ensureClaudeVolume` rsync
line 315), `packages/sandbox-cloud/src/cloud-provider.ts` (`create`),
`apps/cli/src/session-teleport/cwd-encoding.ts` (the encoding precedent).
