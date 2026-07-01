/**
 * Cloud live-box workspace resync — the cloud analog of docker's session-start
 * `resyncWorkspaceFromHost`, closing the "Phase 2" gap. A cloud box has no host
 * `.git/` bind mount, so the host branch tip isn't in the box's object store and
 * the concern's central `git merge <hostRef>` can't run directly.
 *
 * Core idea: **pre-fetch, then reuse `resyncWorkspace` UNCHANGED.** For each
 * worktree we (1) find the shared ancestor `P` (the fork base `S`, already in the
 * box), (2) ship `P..H` (host tip) + a `git stash create` object as a git bundle
 * and fetch it into the box under private `refs/agentbox-resync/*`, then (3) run
 * the golden-tested `resyncWorkspace` orchestration with cloud ports:
 *   - `resolveHostRef` returns the in-box `refs/agentbox-resync/target` (or null
 *     when no shared ancestor → the concern skips the merge, still overlays
 *     untracked — non-destructive);
 *   - `createHostStash` returns the bundled stash SHA (now an in-box object, so
 *     `git stash apply <sha>` resolves);
 *   - the other host ports (`listHostUntracked`/`hashHostFile`/`packHostFiles`)
 *     are the shared `makeHostGitPorts()`;
 *   - the box ports run via `backend.exec`/`uploadFile`.
 *
 * **Never `reset --hard`.** The merge only ADDs a merge commit (box work survives
 * as its first parent); box wins every conflict. Failure modes degrade to a
 * non-destructive untracked overlay or a no-op. This is the only net-new-behaviour
 * piece of the sync refactor — it mutates a live box working dir.
 */

import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CloudBackend,
  CloudHandle,
  RepoResyncResult,
  ResyncExecResult,
  ResyncWorktree,
  WorkspaceResyncPorts,
} from '@agentbox/core';
import { makeHostGitPorts, resyncWorkspace } from '@agentbox/sandbox-core';
import { bashScript, quoteShellArg, quoteShellArgv } from '../shell.js';

/** Private in-box refs the pre-fetch writes; force-updated each resync, cleaned up after. */
const TARGET_REF = 'refs/agentbox-resync/target';
const STASH_REF = 'refs/agentbox-resync/stash';
const SHA_RE = /^[0-9a-f]{40}$/;
/** Cap on the box branch walk when searching for the shared ancestor. */
const BOX_REVLIST_CAP = 500;

interface Prefetched {
  /** The in-box merge target ref, or null when no shared ancestor was found (skip merge). */
  targetRef: string | null;
  /** The bundled host stash SHA (now an in-box object), or null when clean/unusable. */
  stashSha: string | null;
  /** The worktree's box branch — the resolveHostRef fallback so untracked overlay still runs. */
  branch: string;
}

/**
 * Resync each cloud box worktree with the host's current state (merge + overlay,
 * box wins). Pre-fetches the host commits into the box, then drives the
 * provider-neutral `resyncWorkspace` concern through cloud ports.
 */
export async function resyncCloudWorkspace(
  backend: CloudBackend,
  handle: CloudHandle,
  worktrees: ResyncWorktree[],
  onLog?: (line: string) => void,
): Promise<RepoResyncResult[]> {
  const log = onLog ?? (() => {});
  // Vercel/E2B wrap non-root execs in `sudo -u vscode -H bash -lc`, whose extra
  // re-parse mangles the untracked probe's `$(...)`/`$var`/`while` (→ hang). The
  // probe is read-only, so run it as root there (single `bash -lc`, no re-parse).
  const probeAsRoot = backend.name === 'vercel' || backend.name === 'e2b';
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-resync-'));
  const prefetch = new Map<string, Prefetched>();
  try {
    for (const [i, w] of worktrees.entries()) {
      prefetch.set(w.hostMainRepo, await prefetchRepo(backend, handle, w, stage, i, log));
    }

    const hostPorts = makeHostGitPorts();
    const ports: WorkspaceResyncPorts = {
      ...hostPorts,
      // Merge target = the in-box temp ref. When no shared ancestor was found we
      // fall back to the box branch: the concern treats `hostRef === boxBranch`
      // as "merging self" and skips the merge, but STILL overlays the host's
      // untracked files (non-destructive, box wins) — whereas a null ref would
      // make it skip the whole repo. stashSha is null in that case (no bundle),
      // so the stash overlay is skipped too.
      resolveHostRef: (hostMain) => {
        const pf = prefetch.get(hostMain);
        return Promise.resolve(pf ? (pf.targetRef ?? pf.branch) : null);
      },
      // The stash object is in-box (bundled + fetched); the concern applies by SHA.
      createHostStash: (hostMain) => Promise.resolve(prefetch.get(hostMain)?.stashSha ?? null),
      boxGit: (ct, args) => boxGit(backend, handle, ct, args),
      probeUntrackedTokens: (ct, paths) => probeUntrackedTokens(backend, handle, ct, paths, probeAsRoot),
      applyTarToBox: (ct, tar) => applyTarToBox(backend, handle, stage, ct, tar),
    };

    const results = await resyncWorkspace(worktrees, ports, log);
    await cleanupBoxRefs(backend, handle, worktrees, prefetch);
    return results;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * Pre-fetch one repo's host commits into the box. Returns the in-box merge
 * target ref + bundled stash SHA, or `{ null, null }` to signal "no merge"
 * (overlay-only, non-destructive) on any miss.
 */
async function prefetchRepo(
  backend: CloudBackend,
  handle: CloudHandle,
  w: ResyncWorktree,
  stage: string,
  idx: number,
  log: (line: string) => void,
): Promise<Prefetched> {
  const ct = w.containerPath;
  const hostMain = w.hostMainRepo;
  const none: Prefetched = { targetRef: null, stashSha: null, branch: w.branch };

  // 1. The box branch's commits (newest first), capped.
  const rev = await backend.exec(
    handle,
    bashScript(`git -C ${quoteShellArg(ct)} rev-list --max-count=${String(BOX_REVLIST_CAP)} ${quoteShellArg(w.branch)} 2>/dev/null || true`),
  );
  const boxShas = rev.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => SHA_RE.test(s));
  if (boxShas.length === 0) {
    log(`resync: ${ct}: box branch has no commits; overlay only`);
    return none;
  }

  // 2. Shared ancestor P = the first box commit the host still has (= the fork
  //    base S; box-only commits above S don't exist on the host).
  const batch = await execa(
    'git',
    ['-C', hostMain, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
    { input: boxShas.join('\n'), reject: false },
  );
  const present = new Set<string>();
  for (const line of batch.stdout.split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length >= 2 && parts[1] === 'commit' && parts[0]) present.add(parts[0]);
  }
  const base = boxShas.find((s) => present.has(s));
  if (!base) {
    log(`resync: ${ct}: no shared ancestor with the host (repo replaced?); overlay only (non-destructive)`);
    return none;
  }

  // 3. Host tip H + an uncommitted-changes stash object.
  const hRes = await execa('git', ['-C', hostMain, 'rev-parse', 'HEAD'], { reject: false });
  const hostTip = hRes.stdout.trim();
  if (hRes.exitCode !== 0 || !SHA_RE.test(hostTip)) return none;
  const stashRes = await execa('git', ['-C', hostMain, 'stash', 'create'], { reject: false });
  const stashSha =
    stashRes.exitCode === 0 && SHA_RE.test(stashRes.stdout.trim()) ? stashRes.stdout.trim() : null;

  // 4. Bundle P..H (+ the stash object), excluding everything the box already
  //    has (`^base`). The box holds `base`, so the prerequisite is satisfiable
  //    even though a cloud clone is shallow — no `--unshallow` ever needed.
  //    Only ship the target when the host actually advanced (`H !== base`);
  //    otherwise `target=H ^H` is an empty range (git makes a ref-less bundle →
  //    the in-box fetch can't find it). The stash object is always new content
  //    (its tree isn't reachable from `base`), so it's bundled whenever present.
  const needTarget = hostTip !== base;
  const bundleRefs: string[] = [];
  if (needTarget) bundleRefs.push(TARGET_REF);
  if (stashSha) bundleRefs.push(STASH_REF);
  if (bundleRefs.length === 0) {
    log(`resync: ${ct}: already up to date with the host; overlay untracked only`);
    return { targetRef: null, stashSha: null, branch: w.branch };
  }

  const bundlePath = join(stage, `resync-${String(idx)}.bundle`);
  try {
    if (needTarget) await execa('git', ['-C', hostMain, 'update-ref', TARGET_REF, hostTip], { reject: false });
    if (stashSha) await execa('git', ['-C', hostMain, 'update-ref', STASH_REF, stashSha], { reject: false });
    const b = await execa(
      'git',
      ['-C', hostMain, 'bundle', 'create', bundlePath, ...bundleRefs, `^${base}`],
      { reject: false },
    );
    if (b.exitCode !== 0) {
      log(`resync: ${ct}: bundle build failed; overlay only: ${(b.stderr || '').split('\n')[0]}`);
      return none;
    }
  } finally {
    if (needTarget) await execa('git', ['-C', hostMain, 'update-ref', '-d', TARGET_REF], { reject: false });
    if (stashSha) await execa('git', ['-C', hostMain, 'update-ref', '-d', STASH_REF], { reject: false });
  }

  // 5. Upload + fetch the bundle into the worktree's own .git (private refs).
  const remote = `/tmp/agentbox-resync-${String(idx)}.bundle`;
  await backend.uploadFile(handle, bundlePath, remote);
  const refspecs = bundleRefs.map((r) => `+${r}:${r}`);
  const fetch = await backend.exec(
    handle,
    bashScript(
      `git -C ${quoteShellArg(ct)} fetch --no-tags ${quoteShellArg(remote)} ${refspecs
        .map((r) => quoteShellArg(r))
        .join(' ')} && rm -f ${quoteShellArg(remote)}`,
    ),
  );
  if (fetch.exitCode !== 0) {
    log(`resync: ${ct}: in-box bundle fetch failed; overlay only: ${(fetch.stderr || fetch.stdout || '').split('\n')[0]}`);
    return none;
  }
  log(
    needTarget
      ? `resync: ${ct}: fetched host commits (${base.slice(0, 8)}..${hostTip.slice(0, 8)})${stashSha ? ' + host stash' : ''}`
      : `resync: ${ct}: no new host commits; fetched host stash only`,
  );
  // targetRef null when the host didn't advance → merge skipped, stash + untracked overlay run.
  return { targetRef: needTarget ? TARGET_REF : null, stashSha, branch: w.branch };
}

/** Box-side git via `backend.exec` (mirrors docker's `execInBox` boxGit port). */
async function boxGit(
  backend: CloudBackend,
  handle: CloudHandle,
  ct: string,
  args: string[],
): Promise<ResyncExecResult> {
  const cmd = `git -C ${quoteShellArg(ct)} ${quoteShellArgv(args)}`;
  const r = await backend.exec(handle, bashScript(cmd));
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Probe the box for each host-untracked path: sha256 for a regular file, the
 * non-regular sentinel (`-`) for a dir/symlink, omitted when absent. Paths are
 * fed base64-encoded (no stdin to `backend.exec`, and the box lacks `/dev/fd`).
 */
async function probeUntrackedTokens(
  backend: CloudBackend,
  handle: CloudHandle,
  ct: string,
  relPaths: string[],
  asRoot: boolean,
): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  if (relPaths.length === 0) return tokens;
  const payload = Buffer.from(relPaths.join('\0')).toString('base64');
  const script =
    `printf %s ${quoteShellArg(payload)} | base64 -d | ( cd ${quoteShellArg(ct)} && ` +
    `while IFS= read -r -d '' f; do ` +
    `if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\\0%s\\0' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"; ` +
    `elif [ -e "$f" ]; then printf '%s\\0%s\\0' '-' "$f"; fi; done )`;
  const r = await backend.exec(handle, bashScript(script), asRoot ? { user: 'root' } : undefined);
  if (r.exitCode === 0) {
    const flat = r.stdout.split('\0').filter((s) => s.length > 0);
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const token = flat[i];
      const path = flat[i + 1];
      if (token !== undefined && path !== undefined) tokens.set(path, token);
    }
  }
  return tokens;
}

/** Extract a host-packed tar into the box worktree (buffer → temp file → upload → tar -xf). */
async function applyTarToBox(
  backend: CloudBackend,
  handle: CloudHandle,
  stage: string,
  ct: string,
  tar: Buffer,
): Promise<void> {
  const local = join(stage, 'overlay.tar');
  await writeFile(local, tar);
  const remote = '/tmp/agentbox-resync-overlay.tar';
  await backend.uploadFile(handle, local, remote);
  await backend.exec(
    handle,
    bashScript(`tar -C ${quoteShellArg(ct)} -xf ${quoteShellArg(remote)} && rm -f ${quoteShellArg(remote)}`),
  );
}

/** Best-effort removal of the private in-box refs after the resync. */
async function cleanupBoxRefs(
  backend: CloudBackend,
  handle: CloudHandle,
  worktrees: ResyncWorktree[],
  prefetch: Map<string, Prefetched>,
): Promise<void> {
  for (const w of worktrees) {
    if (!prefetch.get(w.hostMainRepo)?.targetRef) continue;
    const ct = quoteShellArg(w.containerPath);
    await backend
      .exec(
        handle,
        bashScript(
          `git -C ${ct} update-ref -d ${TARGET_REF} 2>/dev/null || true; git -C ${ct} update-ref -d ${STASH_REF} 2>/dev/null || true`,
        ),
      )
      .catch(() => {});
  }
}
