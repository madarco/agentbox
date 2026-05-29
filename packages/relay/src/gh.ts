/**
 * Host-side helpers for the `gh.pr.*` RPCs (PR create / view / list / comment /
 * review / merge / checkout / close / reopen). The relay reuses the host's
 * `gh` install + auth: the in-box agent has no GitHub token, the host does.
 *
 * Same decoupling philosophy as `handleGitRpc`'s direct `git` spawn — we shell
 * out to `gh` with a known `cwd` (the host main repo) so `gh` infers the
 * GitHub repo from `git remote -v` and uses the user's authenticated gh
 * identity. No new credential plumbing inside the box.
 *
 * Lives in its own file so both `server.ts` (docker path) and `host-actions.ts`
 * (cloud path) can share `assertGhReady` + `runHostGh` + the `checkout`
 * guards without creating an import cycle.
 */

import { spawn } from 'node:child_process';
import type { GitRpcResult } from './types.js';

/** Whitelisted subset of `gh pr` ops exposed via RPC. Keep in sync with the ctl CLI. */
export const GH_PR_OPS = [
  'create',
  'view',
  'list',
  'comment',
  'review',
  'merge',
  'checkout',
  'close',
  'reopen',
] as const;

export type GhPrOp = (typeof GH_PR_OPS)[number];

export function isGhPrOp(value: string): value is GhPrOp {
  return (GH_PR_OPS as readonly string[]).includes(value);
}

/** Read-only ops never trigger the host confirmation prompt. */
export const GH_PR_READ_ONLY_OPS: ReadonlySet<GhPrOp> = new Set(['view', 'list']);

/**
 * Ops whose box branch goes in as a leading positional `<ref>` (the way
 * `gh pr view <branch>` / `gh pr merge <branch>` take it). Mirrors the in-box
 * gh shim's table.
 */
const POSITIONAL_BRANCH_OPS: ReadonlySet<GhPrOp> = new Set([
  'view',
  'comment',
  'review',
  'merge',
  'close',
  'reopen',
]);

/** Ops whose box branch goes in as `--head <branch>`. */
const HEAD_BRANCH_OPS: ReadonlySet<GhPrOp> = new Set(['list', 'create']);

/**
 * Inject the box's branch into a `gh pr <op>` argv so the host's `gh` (running
 * with `cwd` in the host main repo, *not* on the box's branch) targets the
 * box's work rather than falling back to whatever the host has checked out.
 * Positional ops get the branch prepended as the ref; `list`/`create` get
 * `--head <branch>`; `checkout` is never touched (it requires an explicit
 * ref). No-op when the caller already supplied a ref or when `branch` is
 * empty / detached `HEAD`. The relay is the single chokepoint: the in-box
 * shim and host CLI forward args verbatim.
 */
export function injectBoxBranch(op: GhPrOp, branch: string | undefined, args: string[]): string[] {
  if (!branch || branch === 'HEAD') return args;
  if (HEAD_BRANCH_OPS.has(op)) {
    return hasHeadArg(args) ? args : ['--head', branch, ...args];
  }
  if (POSITIONAL_BRANCH_OPS.has(op)) {
    return hasPositional(args) ? args : [branch, ...args];
  }
  return args;
}

function hasHeadArg(args: string[]): boolean {
  // `gh pr create`/`list` accept `--head`, `--head=<b>`, and the `-H` shorthand
  // in its `-H <b>` / `-H<b>` / `-H=<b>` forms. Recognize all so an explicit
  // head neither gets double-injected nor triggers the no-branch refusal.
  return args.some((a) => a === '--head' || a.startsWith('--head=') || a.startsWith('-H'));
}

/**
 * True when `args` already carries an explicit PR ref. For `gh pr <op>` the ref
 * is always the *leading* positional (`gh pr view 42 …`, `gh pr merge <branch>
 * …`), so we only look at the first token: a leading flag means "no ref, inject
 * the box branch."
 *
 * We deliberately do NOT scan past flags looking for a bare token — that would
 * require knowing every value-taking flag per op (`--body`, `--subject`,
 * `--comment`, `--json`, …, plus short forms), and an incomplete list **fails
 * open**: a flag's value gets mistaken for a ref, injection is skipped, and gh
 * falls back to the host's checked-out branch — the exact wrong-PR bug this
 * guards against. The leading-token rule needs no flag table and **fails
 * safe**: a ref placed *after* flags (`gh pr merge --squash 42`, uncommon)
 * collides with the injected branch and gh errors out rather than ever acting
 * on the wrong PR.
 */
function hasPositional(args: string[]): boolean {
  const first = args[0];
  if (first === undefined) return false;
  // `--` is the POSIX end-of-options marker; a token after it is the ref.
  if (first === '--') return args.length > 1;
  return !first.startsWith('-');
}

/**
 * Ops that act on a specific branch's PR and so MUST run with an explicit ref:
 * everything except `list` (a bare `gh pr list` legitimately lists all PRs, no
 * host-branch leak) and `checkout` (takes a required explicit ref of its own).
 * If we couldn't resolve the box's branch for one of these, the relay refuses
 * rather than let `gh` fall back to the host repo's checked-out branch — which
 * would act on an unrelated PR.
 */
function isBranchRequiredOp(op: GhPrOp): boolean {
  return op === 'create' || POSITIONAL_BRANCH_OPS.has(op);
}

/**
 * True when a branch-required op would run with no resolvable branch — i.e.
 * neither injection nor the caller supplied one. Call *after* {@link injectBoxBranch}.
 */
export function branchTargetUnresolved(op: GhPrOp, args: string[]): boolean {
  if (!isBranchRequiredOp(op)) return false;
  return op === 'create' ? !hasHeadArg(args) : !hasPositional(args);
}

/** Ready-to-send refusal for a branch-required op with no resolvable branch. */
export function branchUnresolvedRefusal(op: GhPrOp): GitRpcResult {
  return {
    exitCode: 65,
    stdout: '',
    stderr:
      `gh pr ${op}: refusing to run without a branch — could not resolve this ` +
      "box's current branch (detached HEAD?), and falling back to the host " +
      "repo's checked-out branch would act on the wrong PR. Ensure the box is " +
      'on a branch (pushed for `create`), or pass the ref explicitly.\n',
  };
}

/**
 * Resolve the box's *live* current branch on the docker path by reading the
 * shared `.git/`'s worktree registry. The box's worktree is registered at
 * `gitWorktreePath` (a container-only path); its per-worktree `HEAD` lives in
 * the host-visible `.git/worktrees/<subdir>/`, so `git worktree list` reflects
 * branch switches the box made after creation (`git checkout -b …`).
 *
 * Returns the live branch name; falls back to `registeredBranch` when the
 * worktree block isn't found; returns `''` when the box is on a detached HEAD
 * (so callers refuse rather than target a stale ref).
 */
export async function resolveLiveBoxBranch(
  hostMainRepo: string,
  gitWorktreePath: string | undefined,
  registeredBranch: string,
): Promise<string> {
  if (!gitWorktreePath) return registeredBranch;
  const r = await runGitProbe(['-C', hostMainRepo, 'worktree', 'list', '--porcelain']);
  if (r.exitCode !== 0) return registeredBranch;
  const live = parseWorktreeBranch(r.stdout, gitWorktreePath);
  // null = block not found (registry drift) → trust the registered branch.
  // '' = found but detached → return empty so the op refuses.
  return live === null ? registeredBranch : live;
}

/**
 * Parse `git worktree list --porcelain` for the branch of the worktree at
 * `gitWorktreePath`. Returns the short branch name, `''` for a detached HEAD,
 * or `null` when no block matches. Pure — unit-testable without spawning git.
 */
export function parseWorktreeBranch(porcelain: string, gitWorktreePath: string): string | null {
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    if (!wtLine || wtLine.slice('worktree '.length).trim() !== gitWorktreePath) continue;
    const branchLine = lines.find((l) => l.startsWith('branch '));
    if (!branchLine) return ''; // detached HEAD (porcelain emits `detached`, no `branch` line)
    const ref = branchLine.slice('branch '.length).trim();
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  }
  return null;
}

/** Wire params for every `gh.pr.<op>` method. Mirrors the new ctl command surface. */
export interface GhPrRpcParams {
  /** Container path the ctl ran in; used to pick the registered worktree. */
  path?: string;
  /** Pass-through argv (`--title`, `--body`, `--label`, `--draft`, `--json`, …). */
  args?: string[];
  /**
   * One-time token minted by the host CLI via `/admin/host-initiated/mint`
   * before invoking `agentbox git pr <op> <box>`. Validated against the
   * relay's in-memory store, scoped to `(boxId, method=gh.pr.<op>)`;
   * consumed on match and the confirm prompt is skipped. Boxes cannot mint
   * tokens (admin endpoint is loopback-only). `AGENTBOX_GH_FORCE` /
   * `AGENTBOX_GH_PR_CHECKOUT` opt-ins still apply — destructive guards do
   * not weaken when host-initiated.
   */
  hostInitiated?: string;
}

const GH_RPC_TIMEOUT_MS = 120_000;
const GH_READY_CACHE_TTL_MS = 60_000;

interface GhReadyCache {
  /** null on success; a ready-to-send error envelope when gh isn't usable. */
  result: GitRpcResult | null;
  expiresAt: number;
}
let ghReadyCache: GhReadyCache | undefined;

/**
 * Returns `null` when the host has a usable, authenticated `gh`. Otherwise
 * returns a ready-to-send `{ exitCode, stdout, stderr }` envelope describing
 * what's missing. Cached for ~60s so a burst of PR ops doesn't reprobe gh on
 * every call.
 *
 * - `gh` missing → exit 127 (matches Bash's "command not found").
 * - `gh` present but `gh auth status` non-zero → exit 4 (gh's own conventional
 *   "not logged in" exit code).
 *
 * We don't pass `--hostname github.com` to `auth status` — agents pointed at
 * a GitHub Enterprise host should also pass. Any authed host is good enough.
 */
export async function assertGhReady(): Promise<GitRpcResult | null> {
  const now = Date.now();
  if (ghReadyCache && ghReadyCache.expiresAt > now) {
    return ghReadyCache.result;
  }
  const result = await probeGh();
  ghReadyCache = { result, expiresAt: now + GH_READY_CACHE_TTL_MS };
  return result;
}

/** Test-only: clear the readiness cache between cases. */
export function _resetGhReadyCacheForTests(): void {
  ghReadyCache = undefined;
}

async function probeGh(): Promise<GitRpcResult | null> {
  const version = await runHostGh(['--version'], process.cwd(), 10_000);
  if (version.exitCode === 127 || /ENOENT/.test(version.stderr)) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: 'gh not installed on host (https://cli.github.com)\n',
    };
  }
  if (version.exitCode !== 0) {
    return {
      exitCode: version.exitCode,
      stdout: '',
      stderr: `gh --version failed: ${version.stderr || version.stdout}`.trimEnd() + '\n',
    };
  }
  const auth = await runHostGh(['auth', 'status'], process.cwd(), 15_000);
  if (auth.exitCode !== 0) {
    return {
      exitCode: 4,
      stdout: '',
      stderr: 'gh not authenticated on host (run `gh auth login`)\n',
    };
  }
  return null;
}

/**
 * Spawn `gh` on the host with the given argv inside `cwd`. Returns the
 * standard `{ exitCode, stdout, stderr }` envelope. Self-contained
 * (doesn't call into `server.ts`'s `runHostCommand`) so this module has no
 * import dependency on the server module — keeps the relay's two RPC
 * dispatch paths (docker `/rpc` and cloud `executeCloudAction`) from
 * importing each other.
 */
export function runHostGh(
  args: string[],
  cwd: string,
  timeoutMs: number = GH_RPC_TIMEOUT_MS,
): Promise<GitRpcResult> {
  return new Promise<GitRpcResult>((resolve) => {
    const child = spawn('gh', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nrelay: gh command timed out after ${String(timeoutMs)}ms\n`;
      finish(124);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT (gh missing) lands here too; surface as exit 127 to match shell semantics.
      const code = (err as NodeJS.ErrnoException).code;
      stderr += String(err.message ?? err);
      finish(code === 'ENOENT' ? 127 : 1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

/**
 * Pre-flight for `gh.pr.checkout`. Refuses when:
 *  - the host repo has uncommitted changes (clobbers WIP), or
 *  - HEAD is currently any registered per-box branch (`agentbox/<name>`) —
 *    the box's bind-mounted `.git/HEAD` would silently flip with the host.
 *
 * Returns a ready-to-send error envelope on refusal, or `null` to proceed.
 */
export async function checkoutGuards(
  hostMainRepo: string,
  registeredBranches: readonly string[],
): Promise<GitRpcResult | null> {
  const status = await runGitProbe(['-C', hostMainRepo, 'status', '--porcelain']);
  if (status.exitCode !== 0) {
    return {
      exitCode: status.exitCode,
      stdout: '',
      stderr:
        `gh pr checkout: failed to inspect host repo: ${status.stderr || status.stdout}`.trimEnd() +
        '\n',
    };
  }
  if (status.stdout.trim().length > 0) {
    return {
      exitCode: 12,
      stdout: '',
      stderr: `gh pr checkout: ${hostMainRepo} has uncommitted changes; refusing to switch branches\n`,
    };
  }
  const head = await runGitProbe(['-C', hostMainRepo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.exitCode !== 0) {
    return {
      exitCode: head.exitCode,
      stdout: '',
      stderr:
        `gh pr checkout: failed to resolve HEAD: ${head.stderr || head.stdout}`.trimEnd() + '\n',
    };
  }
  const currentBranch = head.stdout.trim();
  if (registeredBranches.includes(currentBranch)) {
    return {
      exitCode: 12,
      stdout: '',
      stderr: `gh pr checkout: ${hostMainRepo} is on registered box branch ${currentBranch}; refusing (would corrupt the bind-mounted box HEAD)\n`,
    };
  }
  return null;
}

function runGitProbe(args: string[]): Promise<GitRpcResult> {
  return new Promise<GitRpcResult>((resolve) => {
    const child = spawn('git', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err.message ?? err) });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * `merge` is the most destructive op. `AGENTBOX_PROMPT=off` auto-`y`s every
 * other prompt in the relay; for `gh pr merge` we refuse that bypass unless
 * the user opted in via `AGENTBOX_GH_FORCE=1`. Returns a ready-to-send envelope
 * when the bypass should be refused; `null` otherwise.
 */
export function refuseMergeBypass(op: GhPrOp): GitRpcResult | null {
  if (op !== 'merge') return null;
  if (process.env['AGENTBOX_PROMPT'] !== 'off') return null;
  if (process.env['AGENTBOX_GH_FORCE'] === '1') return null;
  return {
    exitCode: 10,
    stdout: '',
    stderr:
      'gh pr merge: AGENTBOX_PROMPT=off bypass requires AGENTBOX_GH_FORCE=1 (merge is irreversible)\n',
  };
}

/**
 * `gh pr checkout` is gated behind an explicit opt-in env: it mutates the
 * host main repo's `HEAD`, which the bind-mounted box sees too. Returns a
 * ready-to-send envelope when the op should be refused; `null` otherwise.
 */
export function refuseCheckoutByDefault(op: GhPrOp): GitRpcResult | null {
  if (op !== 'checkout') return null;
  if (process.env['AGENTBOX_GH_PR_CHECKOUT'] === 'allow') return null;
  return {
    exitCode: 13,
    stdout: '',
    stderr: 'gh pr checkout: disabled by default; set AGENTBOX_GH_PR_CHECKOUT=allow to enable\n',
  };
}
