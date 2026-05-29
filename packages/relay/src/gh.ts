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
 * Default `gh pr create`'s `--head` to the box's branch so the PR is for the
 * box's work, not whatever the host main repo happens to have checked out
 * (`gh` infers head from the cwd's HEAD, which is the user's own branch — or
 * an untracked one, which aborts with "you must first push the current branch
 * to a remote, or use the --head flag"). Only injected for `create`, only when
 * the caller didn't already pass `--head` (or its `-H` shorthand), and only when we resolved a real
 * branch (not empty / detached `HEAD`). The host CLI's `agentbox git pr create`
 * already injects this; the relay covers the in-box `agentbox-ctl git pr` /
 * `gh pr` path, which forwards args verbatim.
 */
export function injectPrCreateHead(
  op: GhPrOp,
  branch: string | undefined,
  args: string[],
): string[] {
  if (op !== 'create') return args;
  if (!branch || branch === 'HEAD') return args;
  if (hasHeadArg(args)) return args;
  return ['--head', branch, ...args];
}

function hasHeadArg(args: string[]): boolean {
  // `gh pr create` accepts `--head`, `--head=<b>`, and the `-H` shorthand in
  // its `-H <b>` / `-H<b>` / `-H=<b>` forms. Recognize all so an explicit head
  // neither gets double-injected nor triggers the no-head refusal.
  return args.some((a) => a === '--head' || a.startsWith('--head=') || a.startsWith('-H'));
}

/**
 * True when a `gh pr create` would run with no `--head` — i.e. we couldn't
 * resolve the box's branch to inject and the caller didn't pass one. The
 * relay must refuse rather than let `gh` fall back to the host repo's
 * *checked-out* branch, which would open a PR for the wrong branch.
 */
export function prCreateNeedsHead(op: GhPrOp, args: string[]): boolean {
  return op === 'create' && !hasHeadArg(args);
}

/** Ready-to-send refusal for a `create` that has no resolvable `--head`. */
export const PR_CREATE_NO_HEAD_REFUSAL: GitRpcResult = {
  exitCode: 65,
  stdout: '',
  stderr:
    'gh pr create: refusing to run without --head — could not resolve this ' +
    "box's branch, and falling back to the host repo's checked-out branch " +
    'would open a PR for the wrong branch. Ensure the box branch is pushed, ' +
    'or pass --head <branch> explicitly.\n',
};

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
      stderr: `gh pr checkout: failed to inspect host repo: ${status.stderr || status.stdout}`.trimEnd() + '\n',
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
      stderr: `gh pr checkout: failed to resolve HEAD: ${head.stderr || head.stdout}`.trimEnd() + '\n',
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
    stderr:
      'gh pr checkout: disabled by default; set AGENTBOX_GH_PR_CHECKOUT=allow to enable\n',
  };
}
