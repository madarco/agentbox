/**
 * Host-side executor for actions parked by the in-sandbox `box-mode` relay
 * and drained by the `CloudBoxPoller`. This is where the host actually does
 * the work an in-box `agentbox-ctl git push` needs done — with host SSH
 * creds, in the host repo, without ever sending secrets into the box.
 *
 * v0 implements `git.push` and `git.fetch` via the git-bundle pull-back
 * pattern: the in-sandbox `git bundle create` is fetched into a host tmp
 * file, the host repo `git fetch`es the per-box branch from it (always a
 * fast-forward — the per-box branch only ever moves forward), then runs
 * the real `git push origin` / `git fetch origin`. `cp.*`, `download.*`,
 * `checkpoint.create`, `browser.open` are stubbed with a clear "not yet
 * supported for cloud boxes" error so the in-box command unblocks instead
 * of hanging. Filling each in is localized to this file.
 */

import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { findBox, readState } from '@agentbox/sandbox-core';
import {
  assertGhReady,
  checkoutGuards,
  branchTargetUnresolved,
  branchUnresolvedRefusal,
  GH_PR_READ_ONLY_OPS,
  injectBoxBranch,
  isGhPrOp,
  refuseCheckoutByDefault,
  refuseMergeBypass,
  runHostGh,
  type GhPrRpcParams,
} from './gh.js';
import { hashRpcParams, type HostInitiatedTokens } from './host-initiated.js';
import { askPrompt, type PendingPrompts, type PromptSubscribers } from './prompts.js';
import type {
  CheckpointRpcParams,
  CpRpcParams,
  DownloadKind,
  DownloadRpcParams,
  GitRpcParams,
  HostAction,
  HostActionResult,
} from './types.js';

export interface CloudActionExecutorDeps {
  /** From BoxRegistration.backend (e.g. 'daytona'). */
  backendName: string;
  /** From BoxRegistration.boxId. Used to look up the BoxRecord in ~/.agentbox/state.json. */
  boxId: string;
  /** Friendly box name — used in confirm-prompt messages. Falls back to boxId. */
  boxName?: string;
  /** Host relay's pending-prompts queue, for gating destructive ops like git push. */
  prompts?: PendingPrompts;
  /** Host wrapper SSE subscribers — the prompt UX feeds through them. */
  subscribers?: PromptSubscribers;
  /** Host CLI one-time tokens; presence + scope-match skips the confirm prompt. */
  hostInitiatedTokens?: HostInitiatedTokens;
  /** Best-effort logger. */
  log?: (line: string) => void;
}

/**
 * Lazy backend resolver. Hardcoded for the providers we ship; future cloud
 * backends slot in here. Dynamic import keeps the relay process from loading
 * cloud SDKs (heavy CJS trees) until a cloud box is actually registered.
 *
 * ## Runtime contract (the relay→sandbox-* dependency story)
 *
 * The import path is a computed string on purpose — a literal would make
 * esbuild eager-resolve the package at bundle time, and the relay tsup
 * configs intentionally don't depend on the per-backend packages (to avoid
 * a `sandbox-daytona → sandbox-cloud → sandbox-docker → relay` cycle in
 * package.json deps).
 *
 * **At runtime the parent process is responsible for making
 * `@agentbox/sandbox-daytona` (and `@agentbox/sandbox-cloud` for the cp /
 * download / browser-open executors) resolvable from `node_modules` next
 * to the relay bin.** The `@madarco/agentbox` CLI satisfies this by
 * carrying both packages in its build, bundled via `tsup` with
 * `noExternal: [/^@agentbox\//]`. The published `agent-box` npm package
 * ships them inlined; the workspace setup hits the same path via
 * pnpm-symlinked `node_modules`.
 *
 * If you embed `@agentbox/relay` standalone in a different host (no
 * agentbox CLI around), you MUST install `@agentbox/sandbox-daytona`
 * yourself for cloud executors to work — otherwise this throws a clear
 * `MODULE_NOT_FOUND` error and the in-box `/rpc` will see exit 1 with the
 * "no host executor" message above.
 */
export async function resolveCloudBackend(name: string): Promise<CloudBackend> {
  if (name === 'daytona') {
    const pkg = '@agentbox/sandbox-' + 'daytona';
    try {
      const mod = (await import(pkg)) as { daytonaBackend: CloudBackend };
      return mod.daytonaBackend;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cannot find module|MODULE_NOT_FOUND/i.test(msg)) {
        throw new Error(
          `relay: cannot load '${pkg}' at runtime — install it alongside @agentbox/relay (the @madarco/agentbox CLI normally provides this dependency). Original: ${msg}`,
        );
      }
      throw err;
    }
  }
  if (name === 'hetzner') {
    const pkg = '@agentbox/sandbox-' + 'hetzner';
    try {
      const mod = (await import(pkg)) as { hetznerBackend: CloudBackend };
      return mod.hetznerBackend;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cannot find module|MODULE_NOT_FOUND/i.test(msg)) {
        throw new Error(
          `relay: cannot load '${pkg}' at runtime — install it alongside @agentbox/relay (the @madarco/agentbox CLI normally provides this dependency). Original: ${msg}`,
        );
      }
      throw err;
    }
  }
  throw new Error(`no host executor for cloud backend '${name}'`);
}

/**
 * Re-mint the preview URL for a cloud box's `port` after a transport-level
 * failure (the host CloudBoxPoller saw ECONNREFUSED on the local port).
 * Hetzner reopens its SSH ControlMaster + `-L` forward; Daytona's permanent
 * CloudFront alias doesn't need refresh and this returns null.
 *
 * Takes the agentbox `boxId` (the one the relay knows), resolves it to the
 * backend's sandboxId via `~/.agentbox/state.json` the same way
 * `executeCloudAction` does, then asks the backend to refresh.
 *
 * Best-effort: any error during resolve/refresh returns null and the
 * poller stays on the (broken) URL — the next poll will trip the same
 * recovery hook on the next ECONNREFUSED. Throwing here would crash the
 * poller; we'd rather keep retrying.
 */
export async function refreshCloudPreviewUrl(
  backendName: string,
  boxId: string,
  port: number,
): Promise<string | null> {
  try {
    const backend = await resolveCloudBackend(backendName);
    if (!backend.refreshPreviewUrl) return null;
    const lookup = await lookupCloudBox(boxId);
    const handle: CloudHandle = { sandboxId: lookup.cloudSandboxId };
    const url = await backend.refreshPreviewUrl(handle, port);
    return url.url;
  } catch {
    return null;
  }
}

export async function executeCloudAction(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const log = deps.log ?? (() => {});
  log(`executing ${action.method} for box ${deps.boxId}`);

  if (action.method === 'git.push' || action.method === 'git.fetch') {
    return runGitRpc(action, deps);
  }
  if (action.method === 'cp.toHost' || action.method === 'cp.fromHost') {
    return runCpRpc(action, deps);
  }
  if (
    action.method === 'download.workspace' ||
    action.method === 'download.env' ||
    action.method === 'download.config' ||
    action.method === 'download.claude'
  ) {
    return runDownloadRpc(action, deps);
  }
  if (action.method === 'checkpoint.create') {
    return runCheckpointRpc(action, deps);
  }
  if (action.method === 'browser.open.mirror') {
    return runBrowserOpenMirror(action, deps);
  }
  if (action.method.startsWith('gh.pr.')) {
    return runGhPrRpc(action, deps);
  }
  if (action.method === 'git.clone' || action.method === 'gh.repo.clone') {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `${action.method}: not yet implemented (deferred; see docs/plans/gh-and-git-shims-host-only.md). Run \`gh\` / \`git\` on the host directly for now.\n`,
    };
  }
  return {
    exitCode: 1,
    stdout: '',
    stderr: `host executor for '${action.method}' is not yet supported for cloud boxes\n`,
  };
}

/**
 * Cloud `gh.pr.<op>` executor. Simpler than `runGitRpc` because nothing
 * needs to round-trip into the sandbox — `gh` only needs the host repo
 * (already at the right remote in `lookup.workspacePath`).
 *
 * Mirrors the docker handler's confirmation matrix exactly: `view` / `list`
 * are silent, write ops go through `askPrompt`, `checkout` is opt-in via
 * `AGENTBOX_GH_PR_CHECKOUT=allow`, and `merge` refuses `AGENTBOX_PROMPT=off`
 * bypass unless `AGENTBOX_GH_FORCE=1`. When no SSE subscriber is attached,
 * write-op behavior is gated by `AGENTBOX_GH_NO_SUB` (`deny` default,
 * `allow`, or `prompt`) — same shape as `AGENTBOX_GIT_PUSH_NO_SUB`.
 */
async function runGhPrRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const op = action.method.slice('gh.pr.'.length);
  if (!isGhPrOp(op)) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `unknown gh.pr.* op: ${op}\n`,
    };
  }
  // Env-only refusals first — cheap, deterministic, no fs/process calls.
  const mergeBypass = refuseMergeBypass(op);
  if (mergeBypass) return mergeBypass;
  const checkoutOptIn = refuseCheckoutByDefault(op);
  if (checkoutOptIn) return checkoutOptIn;

  const params = (action.params ?? {}) as GhPrRpcParams;
  const args = Array.isArray(params.args)
    ? params.args.filter((a): a is string => typeof a === 'string')
    : [];

  const ghReady = await assertGhReady();
  if (ghReady) return ghReady;

  const lookup = await lookupCloudBox(deps.boxId);

  if (op === 'checkout') {
    // The cloud host repo isn't bind-mounted by anything; the only "branch
    // we must not stomp" concern is the host's own current branch, which is
    // a generic dirty-tree / "already on this branch" question gh itself
    // surfaces. We still refuse a dirty tree.
    const guard = await checkoutGuards(lookup.workspacePath, []);
    if (guard) return guard;
  }

  // Host-initiated `gh pr <op>` (from `agentbox git pr <op> <box>`) skips
  // the confirm prompt — but only with a valid scope-matched, params-hash-
  // bound one-time token. If a token is *present* but invalid, reject
  // hard: attack signal. Only fall through to the prompt when no token was
  // claimed. Destructive-op env opt-ins above still apply.
  const tokenClaimedGhCloud = typeof params.hostInitiated === 'string';
  const incomingHashGhCloud = hashRpcParams(params);
  const hostInitiatedGhOk =
    !GH_PR_READ_ONLY_OPS.has(op) &&
    tokenClaimedGhCloud &&
    (deps.hostInitiatedTokens?.consume(
      params.hostInitiated,
      deps.boxId,
      `gh.pr.${op}`,
      incomingHashGhCloud,
    ) ??
      false);
  if (!GH_PR_READ_ONLY_OPS.has(op) && tokenClaimedGhCloud && !hostInitiatedGhOk) {
    return {
      exitCode: 10,
      stdout: '',
      stderr: 'host-initiated token rejected: invalid, expired, or bound to different params\n',
    };
  }
  if (!GH_PR_READ_ONLY_OPS.has(op) && !hostInitiatedGhOk && deps.prompts && deps.subscribers) {
    const detail = args.join(' ').slice(0, 200);
    const ctx = {
      kind: 'confirm' as const,
      message: `Allow gh pr ${op} from cloud box ${deps.boxName ?? deps.boxId}?`,
      detail,
      defaultAnswer: 'n' as const,
      context: {
        command: `gh pr ${op}`,
        cwd: params.path,
        argv: args,
      },
    };
    const hasSubscriber = deps.subscribers.forBox(deps.boxId).length > 0;
    if (!hasSubscriber && process.env['AGENTBOX_PROMPT'] !== 'off') {
      const noSubMode = (process.env['AGENTBOX_GH_NO_SUB'] ?? 'deny').toLowerCase();
      if (noSubMode === 'deny') {
        return {
          exitCode: 10,
          stdout: '',
          stderr:
            'denied automatically — no attached wrapper to confirm. Attach `agentbox claude` (or similar) and retry, or set AGENTBOX_GH_NO_SUB=allow.\n',
        };
      }
      if (noSubMode === 'allow') {
        deps.log?.(`gh.pr.${op} auto-approved (no subscribers, AGENTBOX_GH_NO_SUB=allow)`);
        // fall through
      } else {
        const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, ctx, {
          ttlMs: 5 * 60 * 1000,
        });
        if (verdict.answer !== 'y') {
          return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
        }
      }
    } else {
      const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, ctx);
      if (verdict.answer !== 'y') {
        return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
      }
    }
  }

  // Target the box's branch for every op (the host repo cwd is on the user's
  // own branch, so gh can't infer it). No shared `.git/` on the cloud host, so
  // probe the sandbox's *live* HEAD over the wire — the cloud equivalent of
  // the docker `git worktree list` read. A detached HEAD / failed probe yields
  // an empty branch, which the refusal below converts to a clear error rather
  // than letting gh act on the host's branch.
  const backend = await resolveCloudBackend(deps.backendName);
  const handle: CloudHandle = { sandboxId: lookup.cloudSandboxId };
  const containerPath = params.path ?? '/workspace';
  const branchProbe = await backend.exec(
    handle,
    `git -C ${shellQuote(containerPath)} rev-parse --abbrev-ref HEAD`,
  );
  const probed = branchProbe.exitCode === 0 ? (branchProbe.stdout ?? '').trim() : '';
  // `rev-parse --abbrev-ref HEAD` prints `HEAD` for a detached head — treat as
  // unresolved so injectBoxBranch skips and the op refuses.
  const branch = probed === 'HEAD' ? '' : probed;
  const finalArgs = injectBoxBranch(op, branch, args);
  // Never let `gh` fall back to the host repo's checked-out branch.
  if (branchTargetUnresolved(op, finalArgs)) return branchUnresolvedRefusal(op);
  return runHostGh(['pr', op, ...finalArgs], lookup.workspacePath);
}

/**
 * Mirror an in-box `browser.open` notification on the host. The action runs
 * detached from the box's `/rpc` (the in-box handler responded 200 long
 * before queuing this), so blocking here doesn't tie up an agent — we can
 * happily wait for the host user's verdict with a TTL fallback.
 *
 * On `y` we spawn `open <url>` on the host. Any other verdict (deny / TTL
 * timeout / no subscribers) silently drops the link. Always resolves
 * exit 0 because the box doesn't observe the result.
 */
async function runBrowserOpenMirror(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const params = (action.params ?? {}) as { url?: string };
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  if (!deps.prompts || !deps.subscribers) return { exitCode: 0, stdout: '', stderr: '' };
  if (process.env['AGENTBOX_PROMPT'] === 'off') {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  // 90s TTL matches the docker browser.open behavior closely enough that an
  // attached user has plenty of time to answer without leaving a stale
  // prompt indefinitely.
  const TTL_MS = 90_000;
  try {
    const verdict = await askPrompt(
      deps.prompts,
      deps.subscribers,
      deps.boxId,
      {
        kind: 'confirm',
        message: `Open link from cloud box ${deps.boxName ?? deps.boxId} on the host?`,
        detail: url,
        defaultAnswer: 'n',
        context: { command: 'browser.open', argv: [url] },
      },
      { ttlMs: TTL_MS },
    );
    if (verdict.answer === 'y' && !verdict.cancelled) {
      // macOS `open` is the only supported launcher today (Daytona client is
      // mac/Linux; on Linux the same call no-ops or errors — either way the
      // box doesn't observe). Spawn detached so the relay loop isn't blocked.
      const { spawn } = await import('node:child_process');
      const child = spawn('open', [url], { stdio: 'ignore', detached: true });
      child.unref();
    }
  } catch (err) {
    deps.log?.(`browser.open.mirror failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { exitCode: 0, stdout: '', stderr: '' };
}

interface BoxLookup {
  workspacePath: string;
  cloudSandboxId: string;
}

async function lookupCloudBox(boxId: string): Promise<BoxLookup> {
  const state = await readState();
  const hit = findBox(boxId, state);
  if (hit.kind !== 'ok') {
    throw new Error(`box ${boxId} not in ~/.agentbox/state.json`);
  }
  const sid = hit.box.cloud?.sandboxId;
  if (!sid) {
    throw new Error(`box ${boxId} has no cloud.sandboxId — record is malformed`);
  }
  return { workspacePath: hit.box.workspacePath, cloudSandboxId: sid };
}

/**
 * Cloud cp helpers live in `@agentbox/sandbox-cloud` — same dynamic-import
 * trick as `resolveCloudBackend` keeps the relay bundle from eagerly pulling
 * the cloud package (and its sandbox-docker transitive). Imports the helpers
 * once and caches; only loaded the first time a cloud box queues `cp.*`.
 *
 * Same runtime contract as `resolveCloudBackend`: the parent process is
 * responsible for making `@agentbox/sandbox-cloud` resolvable next to the
 * relay bin. The @madarco/agentbox CLI bundles it; standalone embedders
 * must install it themselves. See the longer note on `resolveCloudBackend`.
 */
interface CloudCpModule {
  uploadToCloudBox(
    backend: CloudBackend,
    handle: CloudHandle,
    hostSrc: string,
    boxDst: string,
  ): Promise<{ finalPath: string }>;
  downloadFromCloudBox(
    backend: CloudBackend,
    handle: CloudHandle,
    boxSrc: string,
    hostDst: string,
  ): Promise<{ finalPath: string }>;
  pullCloudDirContents(
    backend: CloudBackend,
    handle: CloudHandle,
    boxSrc: string,
    hostDst: string,
  ): Promise<{ finalPath: string }>;
}

let cloudCpModule: CloudCpModule | undefined;
async function loadCloudCp(): Promise<CloudCpModule> {
  if (cloudCpModule) return cloudCpModule;
  // Computed string defeats esbuild's static resolution — see resolveCloudBackend.
  const pkg = '@agentbox/sandbox-' + 'cloud';
  try {
    const mod = (await import(pkg)) as CloudCpModule;
    cloudCpModule = mod;
    return mod;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/cannot find module|MODULE_NOT_FOUND/i.test(msg)) {
      throw new Error(
        `relay: cannot load '${pkg}' at runtime — install it alongside @agentbox/relay (the @madarco/agentbox CLI normally provides this dependency). Original: ${msg}`,
      );
    }
    throw err;
  }
}

async function runCpRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const params = (action.params ?? {}) as Partial<CpRpcParams>;
  if (typeof params.boxPath !== 'string' || typeof params.hostPath !== 'string') {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'cp.* requires {boxPath, hostPath} strings\n',
    };
  }
  const direction = action.method === 'cp.toHost' ? 'box -> host' : 'host -> box';
  // Same askPrompt UX as docker's /rpc handler — keeps the in-box agent from
  // pulling host files / scattering box files without explicit consent.
  if (deps.prompts && deps.subscribers) {
    const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, {
      kind: 'confirm',
      message: `Allow cp (${direction}) on ${deps.boxName ?? deps.boxId}?`,
      detail:
        action.method === 'cp.toHost'
          ? `${params.boxPath} -> ${params.hostPath}`
          : `${params.hostPath} -> ${params.boxPath}`,
      defaultAnswer: 'n',
      context: {
        command: action.method,
        argv: [params.boxPath, params.hostPath],
      },
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
    }
  }
  const lookup = await lookupCloudBox(deps.boxId);
  const backend = await resolveCloudBackend(deps.backendName);
  const handle: CloudHandle = { sandboxId: lookup.cloudSandboxId };
  const cp = await loadCloudCp();
  try {
    const result =
      action.method === 'cp.toHost'
        ? await cp.downloadFromCloudBox(backend, handle, params.boxPath, params.hostPath)
        : await cp.uploadToCloudBox(backend, handle, params.hostPath, params.boxPath);
    return { exitCode: 0, stdout: `${result.finalPath}\n`, stderr: '' };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `cp failed: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

/**
 * Capture a checkpoint by shelling out to the installed `agentbox` CLI
 * (same decoupling as the docker handler — the CLI owns checkpoint name
 * allocation, the `--set-default` config write, snapshot store layout, and
 * the cloud-snapshot creation via `provider.checkpoint.create`). The CLI's
 * `checkpoint create` is already provider-aware, so this path works for
 * both backends; we just hand it the box id.
 */
async function runCheckpointRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const params = (action.params ?? {}) as Partial<CheckpointRpcParams>;
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'relay: AGENTBOX_CLI_ENTRY not set; cannot run checkpoint host-side\n',
    };
  }
  const argv = [process.execPath, entry, 'checkpoint', 'create', deps.boxId];
  if (params.name) argv.push('--name', params.name);
  // --merged is docker-image-layer specific (flatten). For cloud snapshots
  // it's a no-op; pass it through anyway so the CLI's docker branch sees it
  // and the cloud branch ignores it cleanly.
  if (params.merged === true) argv.push('--merged');
  if (params.setDefault === true) argv.push('--set-default');
  if (params.replace === true) argv.push('--replace');
  const result = await execa(argv[0]!, argv.slice(1), { reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function runDownloadRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const params = (action.params ?? {}) as Partial<DownloadRpcParams>;
  const kind = (action.method.split('.')[1] ?? 'workspace') as DownloadKind;
  // Only `workspace` lands cleanly on cloud today — env/config/claude live in
  // per-agent volumes and aren't routed yet (Phase 6 follow-up; see backlog
  // 2.2). Surface a clear error instead of pretending to succeed.
  if (kind !== 'workspace') {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `download.${kind} is not yet supported for cloud boxes (only download.workspace is)\n`,
    };
  }
  if (deps.prompts && deps.subscribers) {
    const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, {
      kind: 'confirm',
      message: `Allow download (${kind}) from ${deps.boxName ?? deps.boxId}?`,
      detail: params.hostPath ?? '(default host location)',
      defaultAnswer: 'n',
      context: {
        command: action.method,
        argv: params.hostPath ? [params.hostPath] : [],
      },
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
    }
  }
  const lookup = await lookupCloudBox(deps.boxId);
  const backend = await resolveCloudBackend(deps.backendName);
  const handle: CloudHandle = { sandboxId: lookup.cloudSandboxId };
  const cp = await loadCloudCp();
  // params.hostPath is reserved in the wire shape; v1 lands /workspace under
  // box.workspacePath (the host project root), matching docker's default.
  const hostDst =
    typeof params.hostPath === 'string' && params.hostPath.length > 0
      ? params.hostPath
      : lookup.workspacePath;
  try {
    const result = await cp.pullCloudDirContents(backend, handle, '/workspace', hostDst);
    return { exitCode: 0, stdout: `${result.finalPath}\n`, stderr: '' };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `download failed: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

/**
 * Git RPC executor for cloud boxes. The push direction:
 *
 *   1. In the sandbox, write a bundle of the per-box branch.
 *   2. Download the bundle to the host.
 *   3. Fetch the bundle ref into the host repo (always a fast-forward).
 *   4. Run the real git push from the host repo.
 *
 * Fetch direction is the mirror: host fetches origin, bundles, uploads,
 * sandbox fetches from the bundle, in-box `agentbox-ctl git pull` then
 * does its local merge as today.
 */
async function runGitRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const params = (action.params ?? {}) as GitRpcParams;
  const lookup = await lookupCloudBox(deps.boxId);
  const backend = await resolveCloudBackend(deps.backendName);
  const handle = { sandboxId: lookup.cloudSandboxId };

  // The in-box ctl sends `params.path = process.cwd()`. When the user runs
  // `agentbox-ctl git push` from anywhere outside /workspace (e.g. $HOME),
  // that path won't be a git repo and `git rev-parse` would fail. Fall back
  // to /workspace whenever the supplied path can't resolve a git dir — the
  // per-box branch only ever lives at /workspace anyway.
  let containerPath = params.path ?? '/workspace';
  if (containerPath !== '/workspace') {
    const probe = await backend.exec(
      handle,
      `git -C ${shellQuote(containerPath)} rev-parse --git-dir`,
    );
    if (probe.exitCode !== 0) containerPath = '/workspace';
  }

  // 1. Resolve the box's current branch (the per-box `agentbox/<name>`).
  const branchProbe = await backend.exec(
    handle,
    `git -C ${shellQuote(containerPath)} rev-parse --abbrev-ref HEAD`,
  );
  const branch = (branchProbe.stdout ?? '').trim();
  if (branchProbe.exitCode !== 0 || branch.length === 0 || branch === 'HEAD') {
    return {
      exitCode: branchProbe.exitCode || 1,
      stdout: '',
      stderr: `failed to resolve branch in sandbox ${containerPath}: ${branchProbe.stderr || branch}`,
    };
  }

  // Gate `git.push` (and only `git.push`) behind the same host-side confirm
  // prompt the Docker provider already uses. The wrapper's SSE subscriber on
  // /admin/prompts/stream surfaces it as a footer y/N; `askPrompt` returns
  // auto-`y` when AGENTBOX_PROMPT=off (matches Docker behavior).
  // Per-box `agentbox/<name>` branches bypass the gate — pushing to them is
  // the box's whole job; the prompt would only ever ask about other branches.
  const isAgentboxBranch = branch.startsWith('agentbox/');
  // Host-initiated pushes (driven by `agentbox git push <box>`) skip the
  // confirm prompt — but only with a valid scope-matched, params-hash-bound
  // one-time token. If a token is *present* but invalid (mutated args,
  // replayed, expired), reject hard: that's an attack signal. Only fall
  // through to the prompt when no token was claimed.
  const tokenClaimedGit = typeof params.hostInitiated === 'string';
  const incomingHashGit = hashRpcParams(params);
  const hostInitiatedOk =
    !isAgentboxBranch &&
    tokenClaimedGit &&
    (deps.hostInitiatedTokens?.consume(
      params.hostInitiated,
      deps.boxId,
      'git.push',
      incomingHashGit,
    ) ??
      false);
  if (action.method === 'git.push' && !isAgentboxBranch && tokenClaimedGit && !hostInitiatedOk) {
    return {
      exitCode: 10,
      stdout: '',
      stderr: 'host-initiated token rejected: invalid, expired, or bound to different params\n',
    };
  }
  if (
    action.method === 'git.push' &&
    !isAgentboxBranch &&
    !hostInitiatedOk &&
    deps.prompts &&
    deps.subscribers
  ) {
    // Cloud-specific fallback: when no SSE subscriber is attached the prompt
    // would block indefinitely (the user has nothing to answer in). Choose
    // up-front whether to auto-deny (default) or auto-approve based on env
    // — same env knob shape as `AGENTBOX_PROMPT`. The decision is bounded
    // by `AGENTBOX_GIT_PUSH_NO_SUB`: 'deny' (default), 'allow', or 'prompt'
    // (block anyway, legacy behavior).
    const hasSubscriber = deps.subscribers.forBox(deps.boxId).length > 0;
    if (!hasSubscriber && process.env['AGENTBOX_PROMPT'] !== 'off') {
      const noSubMode = (process.env['AGENTBOX_GIT_PUSH_NO_SUB'] ?? 'deny').toLowerCase();
      if (noSubMode === 'deny') {
        return {
          exitCode: 10,
          stdout: '',
          stderr:
            'denied automatically — no attached wrapper to confirm. Attach `agentbox claude` (or similar) and retry, or set AGENTBOX_GIT_PUSH_NO_SUB=allow.\n',
        };
      }
      if (noSubMode === 'allow') {
        deps.log?.('git.push auto-approved (no subscribers, AGENTBOX_GIT_PUSH_NO_SUB=allow)');
        // Fall through to the actual push.
      } else {
        // 'prompt' or anything else: legacy blocking behavior with a TTL so
        // a never-attaching user doesn't wedge the executor forever.
        const verdict = await askPrompt(
          deps.prompts,
          deps.subscribers,
          deps.boxId,
          {
            kind: 'confirm',
            message: `Allow git push from cloud box ${deps.boxName ?? deps.boxId}?`,
            detail:
              `${params.remote ?? 'origin'} ${branch} ${(params.args ?? []).join(' ')}`.trim(),
            defaultAnswer: 'n',
            context: { command: 'git push', cwd: containerPath, argv: params.args },
          },
          { ttlMs: 5 * 60 * 1000 },
        );
        if (verdict.answer !== 'y') {
          return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
        }
      }
    } else {
      const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, {
        kind: 'confirm',
        message: `Allow git push from cloud box ${deps.boxName ?? deps.boxId}?`,
        detail: `${params.remote ?? 'origin'} ${branch} ${(params.args ?? []).join(' ')}`.trim(),
        defaultAnswer: 'n',
        context: { command: 'git push', cwd: containerPath, argv: params.args },
      });
      if (verdict.answer !== 'y') {
        return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
      }
    }
  }

  const stage = await mkdtemp(join(tmpdir(), 'agentbox-git-rpc-'));
  const hostBundle = join(stage, 'op.bundle');
  const remoteBundle = '/tmp/agentbox-rpc.bundle';
  try {
    if (action.method === 'git.push') {
      // 2a. Bundle the per-box branch inside the sandbox.
      const make = await backend.exec(
        handle,
        `git -C ${shellQuote(containerPath)} bundle create ${shellQuote(remoteBundle)} ${shellQuote(branch)}`,
      );
      if (make.exitCode !== 0) {
        return {
          exitCode: make.exitCode,
          stdout: '',
          stderr: `bundle create failed: ${make.stderr || make.stdout}`,
        };
      }
      // 2b. Download to host tmp.
      await backend.downloadFile(handle, remoteBundle, hostBundle);
      // 3. Fast-forward the host repo's per-box branch ref to the sandbox tip.
      const fetch = await execa(
        'git',
        ['-C', lookup.workspacePath, 'fetch', hostBundle, `${branch}:${branch}`],
        { reject: false },
      );
      if (fetch.exitCode !== 0) {
        return {
          exitCode: fetch.exitCode ?? 1,
          stdout: fetch.stdout ?? '',
          stderr: `host git fetch from bundle failed: ${fetch.stderr ?? ''}`,
        };
      }
      // 4. Real push. Args are user-controlled (`agentbox-ctl git push --
      // <args>`); pass them through to git on the host. Remote defaults to
      // 'origin'; the bundle's branch is the explicit refspec.
      const remote = params.remote ?? 'origin';
      const argv = ['-C', lookup.workspacePath, 'push', remote, branch];
      if (Array.isArray(params.args)) {
        for (const a of params.args) if (typeof a === 'string') argv.push(a);
      }
      const push = await execa('git', argv, { reject: false });
      let pushStderr = push.stderr ?? '';
      // After a successful push, sync the box's view of origin to match what
      // a normal local `git push -u` would have left behind: write the pushed
      // tip into the box's `refs/remotes/origin/<branch>` and set the branch
      // upstream to track it. Without this, Claude Code's PR badge sees no
      // upstream on the branch and doesn't fetch / display the PR. Per-box
      // scratch branches (`agentbox/<name>`) skip the sync — they're
      // local-only by design.
      if ((push.exitCode ?? 1) === 0 && !branch.startsWith('agentbox/')) {
        try {
          const sha = await execa('git', ['-C', lookup.workspacePath, 'rev-parse', branch], {
            reject: false,
          });
          const shaText = (sha.stdout ?? '').trim();
          if (sha.exitCode === 0 && shaText.length > 0) {
            const updateRef = await backend.exec(
              handle,
              `git -C ${shellQuote(containerPath)} update-ref refs/remotes/${remote}/${branch} ${shellQuote(shaText)}`,
            );
            if (updateRef.exitCode !== 0) {
              pushStderr += `\nrelay: post-push in-box update-ref refs/remotes/${remote}/${branch} failed: ${updateRef.stderr || updateRef.stdout}`;
            }
            const setUpstream = await backend.exec(
              handle,
              `git -C ${shellQuote(containerPath)} branch --set-upstream-to=${remote}/${branch} ${shellQuote(branch)}`,
            );
            if (setUpstream.exitCode !== 0) {
              pushStderr += `\nrelay: post-push in-box --set-upstream-to=${remote}/${branch} failed: ${setUpstream.stderr || setUpstream.stdout}`;
            }
          } else {
            pushStderr += `\nrelay: post-push rev-parse ${branch} failed on host; skipping in-box origin/upstream sync`;
          }
        } catch (err) {
          pushStderr += `\nrelay: post-push in-box origin/upstream sync threw: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return {
        exitCode: push.exitCode ?? 1,
        stdout: push.stdout ?? '',
        stderr: pushStderr,
      };
    }
    // git.fetch: host fetches origin, bundles, uploads, sandbox fetches.
    const remote = params.remote ?? 'origin';
    const hostFetch = await execa('git', ['-C', lookup.workspacePath, 'fetch', remote], {
      reject: false,
    });
    if (hostFetch.exitCode !== 0) {
      return {
        exitCode: hostFetch.exitCode ?? 1,
        stdout: hostFetch.stdout ?? '',
        stderr: `host git fetch failed: ${hostFetch.stderr ?? ''}`,
      };
    }
    // Bundle origin's remote-tracking refs so the sandbox sees the updates.
    const bundle = await execa(
      'git',
      ['-C', lookup.workspacePath, 'bundle', 'create', hostBundle, `--all`],
      { reject: false },
    );
    if (bundle.exitCode !== 0) {
      return {
        exitCode: bundle.exitCode ?? 1,
        stdout: '',
        stderr: `host git bundle create failed: ${bundle.stderr ?? ''}`,
      };
    }
    await backend.uploadFile(handle, hostBundle, remoteBundle);
    const sandboxFetch = await backend.exec(
      handle,
      `git -C ${shellQuote(containerPath)} fetch ${shellQuote(remoteBundle)} '+refs/heads/*:refs/remotes/origin/*' --tags`,
    );
    return {
      exitCode: sandboxFetch.exitCode,
      stdout: sandboxFetch.stdout,
      stderr: sandboxFetch.stderr,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await backend.exec(handle, `rm -f ${shellQuote(remoteBundle)}`).catch(() => {
      /* best-effort */
    });
  }
}

/** Local helper — sandbox-cloud's `quoteShellArg` would be a cross-package import. */
function shellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
