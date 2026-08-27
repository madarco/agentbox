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
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveSshConfigTarget } from '@agentbox/sandbox-core';
import { ghHostFromRemote, repoSlugFromRemote } from './git-pat.js';
import type { GitRpcResult } from './types.js';

/** Whitelisted subset of `gh pr` ops exposed via RPC. Keep in sync with the ctl CLI. */
/**
 * `gh` policy: a blacklist, not an allowlist.
 *
 * The original model proxied a curated set of subcommands and refused the
 * rest, which meant every new agent workflow (`gh issue`, `gh search`,
 * `gh release`) hit "not proxied" and needed a code change to unblock —
 * see issue #304. The surface is now open, with three narrow exceptions:
 *
 *   1. {@link GH_BLOCKED} — refused outright. Credential dumps, and anything
 *      that mutates the HOST's auth state. The host owns the credential; a
 *      box must not be able to read it or move it.
 *   2. {@link GH_DESTRUCTIVE} — always confirmed with the user, even when
 *      the box carries `box.autoApproveSafeHostActions`. Reserved for the
 *      irreversible: deleting a repo, a release, a secret. `pr merge` is
 *      deliberately NOT here — merging is ordinary agent work and is
 *      revertable.
 *   3. everything else — allow-once. The grant is the decision; calls run
 *      silently by default, and prompt per-call when the box opts into
 *      strict mode (`box.autoApproveSafeHostActions: false`).
 *
 * Patterns match the space-joined argv, case-insensitively.
 */
export const GH_BLOCKED: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /^auth\s+(token|refresh)\b/i,
    why: 'prints or rotates the host credential',
  },
  {
    pattern: /^auth\s+(login|logout|switch|setup-git)\b/i,
    why: "changes the host's GitHub auth state, which the host owns",
  },
  {
    pattern: /^config\s+set\b/i,
    why: "rewrites the host's gh configuration",
  },
  {
    // `gh alias set x '!sh -c ...'` defines a shell escape that later runs on
    // the host under the host's credentials.
    pattern: /^alias\s+(set|delete|import)\b/i,
    why: 'defines host-side command aliases that later run with host credentials',
  },
  {
    pattern: /^extension\s+(install|remove|upgrade|exec)\b/i,
    why: 'installs or runs third-party code on the host',
  },
  {
    pattern: /^(ssh-key|gpg-key)\s+(add|delete)\b/i,
    why: "changes the host account's keys",
  },
];

export const GH_DESTRUCTIVE: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /^repo\s+(delete|archive|rename|transfer)\b/i, what: 'repository' },
  { pattern: /^release\s+delete(-asset)?\b/i, what: 'release' },
  { pattern: /^secret\s+(set|delete)\b/i, what: 'repository secret' },
  { pattern: /^variable\s+delete\b/i, what: 'repository variable' },
  { pattern: /^cache\s+delete\b/i, what: 'Actions cache' },
  { pattern: /^ruleset\b.*\b(delete|edit)\b/i, what: 'repository ruleset' },
  { pattern: /^org\s+\S*\b(delete|remove)\b/i, what: 'organization' },
  { pattern: /^gist\s+delete\b/i, what: 'gist' },
  { pattern: /^label\s+delete\b/i, what: 'label' },
  { pattern: /^project\s+(delete|item-delete|field-delete)\b/i, what: 'project' },
  // `gh api -X DELETE` reaches all of the above through the raw API. gh
  // accepts `-X DELETE`, `-X=DELETE`, `-XDELETE` and `--method[= ]DELETE`,
  // so match every spelling — a missed one is a silent hole, not a typo.
  { pattern: /(^|\s)(-X=?\s*|--method[=\s]+)(DELETE|PUT|PATCH)\b/i, what: 'raw API write' },
  // `gh api graphql -f query='mutation { deleteRepository ... }'` is a POST,
  // so no method flag betrays it. GraphQL is a raw write channel with the same
  // reach as the REST verbs above; agents rarely need it, so confirming every
  // mutation is a cheap way to keep the hole shut.
  { pattern: /^api\s+graphql\b[\s\S]*\bmutation\b/i, what: 'raw GraphQL mutation' },
];

/**
 * gh accepts a few global flags BEFORE the subcommand (`gh -R o/r issue list`),
 * and every policy pattern here is anchored at the start of argv. Without
 * stripping them, `gh -R o/r auth token` would present as argv starting with
 * `-R` and match nothing — sailing past the blocklist, the destructive
 * confirm, and the `pr checkout` opt-in alike.
 *
 * Returns argv from the first non-flag token onward. Value-taking global flags
 * consume their value; unknown leading flags are dropped conservatively (a
 * dropped flag can only make a pattern MORE likely to match, never less).
 */
const GH_GLOBAL_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

export function ghVerbArgv(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) break;
    // `--repo=o/r` / `-Ro/r` carry their value inline; the split forms eat the
    // next token.
    if (GH_GLOBAL_VALUE_FLAGS.has(arg)) i += 2;
    else i += 1;
  }
  return args.slice(i);
}

/** Ready-to-send refusal when the argv is on the hard blocklist. */
export function refuseBlockedGhCall(args: readonly string[]): GitRpcResult | null {
  const joined = ghVerbArgv(args).join(' ');
  for (const { pattern, why } of GH_BLOCKED) {
    if (pattern.test(joined)) {
      return {
        exitCode: 65,
        stdout: '',
        stderr:
          `gh ${joined}: refused — ${why}. The host runs gh with its own credentials, ` +
          `so the box never needs them.\n`,
      };
    }
  }
  return null;
}

/**
 * The thing this argv would irreversibly change, or null when it is ordinary
 * work. A non-null result always raises a confirm, regardless of the box's
 * auto-approve setting.
 */
export function ghDestructiveTarget(args: readonly string[]): string | null {
  const joined = ghVerbArgv(args).join(' ');
  for (const { pattern, what } of GH_DESTRUCTIVE) {
    if (pattern.test(joined)) return what;
  }
  return null;
}

/**
 * The one thing `gh api` still cannot do through the relay, and it is a
 * transport limit rather than a policy one: `--input` reads a body from stdin
 * or a file, and the host `gh` runs with stdin ignored, so the request would
 * silently send nothing. Point the caller at `-f`/`-F` fields instead.
 *
 * Method and endpoint are no longer gated here — `GH_DESTRUCTIVE` catches the
 * irreversible verbs, and everything else is ordinary allow-once work.
 */
export function refuseGhApiInput(args: readonly string[]): GitRpcResult | null {
  for (const arg of args) {
    if (arg === '--input' || arg.startsWith('--input=')) {
      return {
        exitCode: 65,
        stdout: '',
        stderr:
          "gh api: '--input' (stdin/file body) isn't supported through the relay " +
          '(the host gh runs with stdin ignored); use -f/-F fields\n',
      };
    }
  }
  return null;
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
  op: string,
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
 * True when the caller passed an explicit `--head`/`-H` on a `gh pr create`.
 * The safe-subset auto-approve only covers a `create` with NO explicit head:
 * the relay then forces `--head` to the box's sanctioned branch, so the PR can
 * only ever target the box's own work. An explicit head (which could name any
 * branch, e.g. `main`) falls back to the confirm prompt.
 */
export function prCreateHasExplicitHead(op: string, args: string[]): boolean {
  return op === 'create' && hasHeadArg(args);
}

/**
 * True when a `gh pr create` would run with no `--head` — i.e. we couldn't
 * resolve the box's branch to inject and the caller didn't pass one. The
 * relay must refuse rather than let `gh` fall back to the host repo's
 * *checked-out* branch, which would open a PR for the wrong branch.
 */
export function prCreateNeedsHead(op: string, args: string[]): boolean {
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
/** Wire params for `gh.exec` — the whole `gh` CLI behind one method. */
export interface GhExecRpcParams {
  /** Container path the ctl ran in; picks the registered worktree. */
  path?: string;
  /** Full gh argv, e.g. `['issue','list','--state','open']`. */
  args?: string[];
  /**
   * One-time token minted by the host CLI before a host-driven
   * `agentbox git pr <op> <box>`. Scope- and params-hash-bound, consumed on
   * match, and skips the confirm. Boxes cannot mint tokens (the mint endpoint
   * is loopback-only); a present-but-invalid token is a hard reject.
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
/** Auth verdicts, keyed by target host (`''` = gh's own default host). */
const ghReadyCache = new Map<string, GhReadyCache>();
/** `gh --version` is host-independent, so it caches on its own. */
let ghInstalledCache: GhReadyCache | undefined;
/** `ssh -G` expansions, keyed by the raw host read off the remote. */
const sshHostCache = new Map<string, { host: string | null; expiresAt: number }>();

/** Where this call's `gh` must be pointed, plus the readiness verdict. */
export interface GhTarget {
  /** `GH_HOST` for every gh spawn in this call; null leaves gh on its default. */
  host: string | null;
  /** Ready-to-send envelope when gh can't serve this host; null when good to go. */
  error: GitRpcResult | null;
}

/**
 * Decide which GitHub host a box's `gh` ops belong to, and whether this machine
 * can serve them. The host comes from the box's REGISTERED origin — never from
 * anything the box says (see `CloudActionExecutorDeps.originUrl`): it selects
 * which instance the host's own authenticated `gh` is pointed at.
 *
 * A github.com origin takes exactly the path it always did — same single
 * `gh auth status` probe, no `GH_HOST`, no extra subprocess.
 *
 * For any other host, `gh` needs `GH_HOST` (without it `gh api` talks to
 * api.github.com whatever the remote says) and the readiness probe needs
 * `--hostname` (a bare `gh auth status` exits non-zero when ANY configured host
 * has a stale token, so one dead github.com entry would mask a perfectly good
 * enterprise login). Before trusting the hostname we expand it through
 * `ssh -G`, exactly as git and gh do, so an `~/.ssh/config` alias
 * (`git@github.com-work:owner/repo`, the usual multi-account setup) resolves to
 * the host that actually answers instead of becoming a bogus `GH_HOST`.
 */
export async function resolveGhTarget(originUrl: string | undefined): Promise<GhTarget> {
  const derived = ghHostFromRemote(originUrl);
  if (!derived) return { host: null, error: await assertGhReady(null) };

  const expanded = derived.aliasable ? await expandSshHost(derived.host) : derived.host;
  // An alias pointing at github.com was never enterprise — take the default path.
  if (expanded === 'github.com') return { host: null, error: await assertGhReady(null) };

  const host = expanded ?? derived.host;
  const scoped = await assertGhReady(host);
  if (!scoped) return { host, error: null };
  // gh missing / broken says nothing about the host; reprobing would just repeat it.
  if (scoped.exitCode !== 4) return { host: null, error: scoped };
  if (expanded === null) {
    // ssh couldn't expand the host, so we can't tell an unauthenticated
    // enterprise host from an alias only gh knows how to resolve. Fall back to
    // what this relay did before it knew about GH_HOST rather than break a
    // setup that works today; keep the host-scoped message if gh is unusable
    // either way, since it is the more specific of the two.
    const generic = await assertGhReady(null);
    return { host: null, error: generic ? scoped : null };
  }
  return { host: null, error: scoped };
}

/**
 * Expand a remote's host through `ssh -G` the way ssh itself would. Returns
 * null when ssh can't answer (not installed, unresolvable) — the caller then
 * treats the hostname as unverified.
 */
async function expandSshHost(host: string): Promise<string | null> {
  const now = Date.now();
  const cached = sshHostCache.get(host);
  if (cached && cached.expiresAt > now) return cached.host;
  let resolved: string | null = null;
  try {
    const target = await resolveSshConfigTarget(host);
    const value = target?.host.trim().toLowerCase() ?? '';
    resolved = value.length > 0 ? value : null;
  } catch {
    resolved = null;
  }
  sshHostCache.set(host, { host: resolved, expiresAt: now + GH_READY_CACHE_TTL_MS });
  return resolved;
}

/**
 * Returns `null` when the host has a usable, authenticated `gh` for `host`
 * (or for gh's default host when `host` is null/omitted). Otherwise returns a
 * ready-to-send `{ exitCode, stdout, stderr }` envelope describing what's
 * missing. Cached per host for ~60s so a burst of PR ops doesn't reprobe gh on
 * every call.
 *
 * - `gh` missing → exit 127 (matches Bash's "command not found").
 * - `gh` present but `gh auth status` non-zero → exit 4 (gh's own conventional
 *   "not logged in" exit code).
 *
 * With no host we don't pass `--hostname` — any authed host is good enough,
 * which is what every github.com box has always relied on.
 */
export async function assertGhReady(host?: string | null): Promise<GitRpcResult | null> {
  const key = host ?? '';
  const now = Date.now();
  const cached = ghReadyCache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;
  const result = await probeGh(host ?? null);
  ghReadyCache.set(key, { result, expiresAt: now + GH_READY_CACHE_TTL_MS });
  return result;
}

/** Test-only: clear the readiness caches between cases. */
export function _resetGhReadyCacheForTests(): void {
  ghReadyCache.clear();
  ghInstalledCache = undefined;
  sshHostCache.clear();
}

async function probeGh(host: string | null): Promise<GitRpcResult | null> {
  const installed = await probeGhInstalled();
  if (installed) return installed;
  // gh authenticates directly from a token in the environment and ignores any
  // stored `gh auth login`. When a token is supplied that way with no stored
  // login, `gh auth status` would falsely report "not logged in" even though
  // every API call succeeds. Treat a present token as authenticated.
  if (firstNonEmptyEnv(ghTokenEnvNames(host))) return null;
  const auth = await runHostGh(
    host ? ['auth', 'status', '--hostname', host] : ['auth', 'status'],
    process.cwd(),
    { timeoutMs: 15_000 },
  );
  if (auth.exitCode !== 0) {
    return {
      exitCode: 4,
      stdout: '',
      stderr: host
        ? `gh not authenticated on host for ${host} (run \`gh auth login --hostname ${host}\`)\n`
        : 'gh not authenticated on host (run `gh auth login`)\n',
    };
  }
  return null;
}

async function probeGhInstalled(): Promise<GitRpcResult | null> {
  const now = Date.now();
  if (ghInstalledCache && ghInstalledCache.expiresAt > now) return ghInstalledCache.result;
  const result = await probeGhVersion();
  ghInstalledCache = { result, expiresAt: now + GH_READY_CACHE_TTL_MS };
  return result;
}

async function probeGhVersion(): Promise<GitRpcResult | null> {
  const version = await runHostGh(['--version'], process.cwd(), { timeoutMs: 10_000 });
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
  return null;
}

/**
 * The env vars gh reads a token from for `host`. gh uses GH_TOKEN /
 * GITHUB_TOKEN for github.com and for Enterprise Cloud tenancy hosts
 * (`*.ghe.com`), and GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN everywhere
 * else — so a GH_TOKEN in the environment says nothing about whether a call to
 * a self-hosted GHES will authenticate.
 */
function ghTokenEnvNames(host: string | null): string[] {
  if (host === null) return ['GH_TOKEN', 'GITHUB_TOKEN'];
  const enterprise = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  return host.endsWith('.ghe.com') ? [...enterprise, 'GH_TOKEN', 'GITHUB_TOKEN'] : enterprise;
}

/** First env var with a real value — `GH_TOKEN=''` means unset, not "set to empty". */
function firstNonEmptyEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Where to run `gh`, and whether it must be told the repo.
 *
 * `gh` infers the repo from its cwd's git remote, so the host checkout is the
 * natural place to run it. A control box has no checkout: passing that path as
 * `cwd` makes the spawn itself fail with a bare `spawn gh ENOENT` (Node reports
 * a missing cwd exactly like a missing binary), which reads as "gh isn't
 * installed" and sent us hunting the wrong problem. Fall back to a directory
 * that exists and name the repo explicitly from the registered origin instead.
 */
export function ghRunContext(
  workspacePath: string,
  originUrl: string | undefined,
  args: string[],
): { cwd: string; args: string[] } {
  if (workspacePath.length > 0 && existsSync(workspacePath)) {
    return { cwd: workspacePath, args };
  }
  const origin = originUrl?.trim() ?? '';
  const alreadyScoped = args.some((a) => a === '--repo' || a === '-R' || a.startsWith('--repo='));
  if (origin.length === 0 || alreadyScoped) return { cwd: tmpdir(), args };
  try {
    return { cwd: tmpdir(), args: ['--repo', repoSlugFromRemote(origin), ...args] };
  } catch {
    return { cwd: tmpdir(), args };
  }
}

export interface RunHostGhOptions {
  /** `GH_HOST` for this spawn; null/omitted leaves gh on its default host. */
  host?: string | null;
  timeoutMs?: number;
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
  opts: RunHostGhOptions = {},
): Promise<GitRpcResult> {
  const timeoutMs = opts.timeoutMs ?? GH_RPC_TIMEOUT_MS;
  return new Promise<GitRpcResult>((resolve) => {
    const child = spawn('gh', args, {
      cwd,
      // GH_HOST is what points gh at a GitHub Enterprise Server instance; without
      // it gh targets github.com no matter what the repo's remote says.
      env: opts.host ? { ...process.env, GH_HOST: opts.host } : process.env,
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
 * `gh pr checkout` stays gated behind an explicit opt-in env even under the
 * open policy, and for a different reason than the rest: it is the one `gh`
 * subcommand that mutates the HOST's working tree rather than something on
 * GitHub. The box's bind-mounted `.git/HEAD` follows the host, so a checkout
 * yanks the branch out from under whatever the user is doing. Returns a
 * ready-to-send envelope when the op should be refused; `null` otherwise.
 */
export function refuseCheckoutByDefault(op: string): GitRpcResult | null {
  if (op !== 'checkout') return null;
  if (process.env['AGENTBOX_GH_PR_CHECKOUT'] === 'allow') return null;
  return {
    exitCode: 13,
    stdout: '',
    stderr: 'gh pr checkout: disabled by default; set AGENTBOX_GH_PR_CHECKOUT=allow to enable\n',
  };
}
