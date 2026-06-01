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
  'diff',
  'checks',
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
export const GH_PR_READ_ONLY_OPS: ReadonlySet<GhPrOp> = new Set([
  'view',
  'list',
  'diff',
  'checks',
]);

/**
 * Whitelisted subset of `gh run` ops exposed via RPC. `list` / `view` are
 * read-only; `rerun` re-triggers CI (a write — gated by the host confirm
 * prompt). `watch` is deliberately absent: it blocks until the run finishes,
 * which doesn't fit the relay's buffered request/response model (the in-box
 * `gh-shim` rejects it and points users at `gh run view`).
 */
export const GH_RUN_OPS = ['list', 'view', 'rerun'] as const;

export type GhRunOp = (typeof GH_RUN_OPS)[number];

export function isGhRunOp(value: string): value is GhRunOp {
  return (GH_RUN_OPS as readonly string[]).includes(value);
}

/** Read-only `gh run` ops never trigger the host confirmation prompt. */
export const GH_RUN_READ_ONLY_OPS: ReadonlySet<GhRunOp> = new Set(['list', 'view']);

// The PR review-comment endpoints. GET lists inline review comments; POST adds
// one (the thing `gh pr comment` can't do). `…/comments/:id/replies` replies to
// a review comment. The optional trailing `(\?…)` lets agents embed GET query
// params in the path (e.g. `…/comments?per_page=50`) rather than via field flags.
const PR_REVIEW_COMMENT = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments(\?.*)?$/;
const PR_REVIEW_COMMENT_REPLY =
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/\d+\/replies(\?.*)?$/;

/**
 * `gh api` endpoints on which POST (create a comment) is proxied — unprompted,
 * since comments are low-risk. Kept separate from the read allowlist so adding
 * a read-only endpoint there later doesn't widen the POST surface.
 */
export const GH_API_WRITE_ALLOWED_ENDPOINTS: readonly RegExp[] = [
  PR_REVIEW_COMMENT,
  PR_REVIEW_COMMENT_REPLY,
];

/**
 * Allowlist of `gh api` endpoint patterns the relay will proxy at all (the
 * overall gate). Superset of the write-allowed list; meant to grow one
 * deliberate entry at a time. GET is allowed on every entry; POST only on the
 * write-allowed subset (see `refuseGhApiCall`).
 */
export const GH_API_ALLOWED_ENDPOINTS: readonly RegExp[] = [...GH_API_WRITE_ALLOWED_ENDPOINTS];

/** True when `endpoint` matches an allowlisted `gh api` pattern (proxied at all). */
export function isAllowedGhApiEndpoint(endpoint: string): boolean {
  return GH_API_ALLOWED_ENDPOINTS.some((re) => re.test(normalizeGhApiEndpoint(endpoint)));
}

/** True when POST is permitted on `endpoint` (the comment endpoints). */
export function isWriteAllowedGhApiEndpoint(endpoint: string): boolean {
  return GH_API_WRITE_ALLOWED_ENDPOINTS.some((re) => re.test(normalizeGhApiEndpoint(endpoint)));
}

/** Strip a leading slash so `/repos/...` and `repos/...` both match. */
function normalizeGhApiEndpoint(endpoint: string): string {
  return endpoint.replace(/^\/+/, '');
}

/** Ready-to-send refusal when a `gh api` endpoint isn't on the allowlist. */
export const GH_API_ENDPOINT_REFUSAL: GitRpcResult = {
  exitCode: 65,
  stdout: '',
  stderr:
    'gh api: endpoint not allowlisted. Proxied: GET on ' +
    'repos/:owner/:repo/pulls/:number/comments (and /:id/replies); POST to those ' +
    'endpoints to add a review comment.\n',
};

/**
 * Endpoint-aware `gh api` policy. Returns a ready-to-send refusal, or `null`
 * when the call may proceed. The caller has already checked the endpoint is on
 * `GH_API_ALLOWED_ENDPOINTS`.
 *
 * - GET → allowed everywhere on the allowlist.
 * - POST → allowed only on the write-allowed comment endpoints (unprompted).
 * - PATCH/PUT/DELETE/etc. → refused.
 * - `--input` → refused: the host `gh` runs with stdin ignored and a box-side
 *   file path wouldn't exist on the host, so it can't cross the relay. Agents
 *   pass fields via `-f`/`-F`.
 *
 * `gh` uses Go's pflag, which accepts a short flag's value glued on (`-XPOST`,
 * `-fbody=hi`) and the `=` form (`-X=POST`, `--method=POST`) as well as the
 * space-separated form. The box-side shim is the convenience gate; this relay
 * guard is the security boundary for a direct `agentbox-ctl` call, so it
 * recognizes every spelling.
 */
export function refuseGhApiCall(endpoint: string, args: string[]): GitRpcResult | null {
  const refuse = (reason: string): GitRpcResult => ({
    exitCode: 65,
    stdout: '',
    stderr: `gh api: ${reason}\n`,
  });

  let explicitMethod: string | null = null;
  let hasFieldFlag = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    // --method / -X with a separately-tokenized value.
    if (arg === '-X' || arg === '--method') {
      explicitMethod = args[i + 1] ?? '';
      i++; // consumed the value
      continue;
    }
    // --method=VALUE / -X=VALUE / -XVALUE (glued short form).
    if (arg.startsWith('--method=')) {
      explicitMethod = arg.slice('--method='.length);
      continue;
    }
    if (arg.startsWith('-X') && arg.length > 2) {
      explicitMethod = arg.slice(2).replace(/^=/, '');
      continue;
    }
    // `--input` (stdin/file body) can't traverse the relay — refuse outright.
    // Its spaced value (if any) is irrelevant; we return before consuming it.
    if (arg === '--input' || arg.startsWith('--input=')) {
      return refuse("'--input' (stdin/file body) isn't supported through the relay; use -f/-F fields");
    }
    // Field flags auto-switch gh api to POST. The SPACED forms take the next
    // token as their value, so consume it — otherwise a method-looking value
    // (e.g. `-f -X=GET`, where pflag binds `-X=GET` as `-f`'s value and POSTs)
    // would be misread as a real `--method` next iteration and downgrade the
    // detected method to GET, slipping a POST past a future read-only endpoint.
    if (arg === '-f' || arg === '-F' || arg === '--field' || arg === '--raw-field') {
      hasFieldFlag = true;
      i++; // consume the value token
      continue;
    }
    // Glued field forms carry their value inline (`-fbody=hi`, `--field=…`). No
    // read-only flag starts with -f / -F, so the prefix match is safe.
    if (arg.startsWith('-f') || arg.startsWith('-F') || arg.startsWith('--field=') || arg.startsWith('--raw-field=')) {
      hasFieldFlag = true;
    }
  }

  const method = (explicitMethod ?? (hasFieldFlag ? 'POST' : 'GET')).toUpperCase();
  if (method === 'GET') return null;
  if (method === 'POST') {
    if (isWriteAllowedGhApiEndpoint(endpoint)) return null;
    return refuse(
      `POST is only proxied to PR review-comment endpoints (repos/:o/:r/pulls/:n/comments[/:id/replies]), not '${endpoint}'`,
    );
  }
  return refuse(`method '${method}' is not proxied — only GET, and POST to comment endpoints, are allowed`);
}

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

/** Wire params for every `gh.run.<op>` method. In-box surface only (no token). */
export interface GhRunRpcParams {
  /** Container path the ctl ran in; used to pick the registered worktree. */
  path?: string;
  /** Pass-through argv (`--json`, `--limit`, `<run-id>`, …). */
  args?: string[];
}

/** Wire params for the `gh.api` method. Read-only, allowlisted endpoints. */
export interface GhApiRpcParams {
  /** Container path the ctl ran in; used to pick the registered worktree. */
  path?: string;
  /** The REST endpoint, e.g. `repos/:owner/:repo/pulls/:number/comments`. */
  endpoint?: string;
  /** Pass-through argv (`--jq`, `--paginate`, `-H`, …). */
  args?: string[];
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
