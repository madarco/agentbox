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
  /** Best-effort logger. */
  log?: (line: string) => void;
}

/**
 * Lazy backend resolver. Hardcoded for the providers we ship; future cloud
 * backends slot in here. Dynamic import keeps the relay process from loading
 * cloud SDKs (heavy CJS trees) until a cloud box is actually registered.
 *
 * The import path is a computed string on purpose — a literal would make
 * esbuild eager-resolve the package at bundle time, and the relay tsup
 * configs intentionally don't depend on the per-backend packages (to avoid
 * a sandbox-daytona ↔ relay dependency cycle). At runtime the package is
 * available via the parent CLI's `dependencies`.
 */
export async function resolveCloudBackend(name: string): Promise<CloudBackend> {
  if (name === 'daytona') {
    const pkg = '@agentbox/sandbox-' + 'daytona';
    const mod = (await import(pkg)) as { daytonaBackend: CloudBackend };
    return mod.daytonaBackend;
  }
  throw new Error(`no host executor for cloud backend '${name}'`);
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
  return {
    exitCode: 1,
    stdout: '',
    stderr: `host executor for '${action.method}' is not yet supported for cloud boxes\n`,
  };
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
  const mod = (await import(pkg)) as CloudCpModule;
  cloudCpModule = mod;
  return mod;
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
  const hostDst = typeof params.hostPath === 'string' && params.hostPath.length > 0
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
async function runGitRpc(action: HostAction, deps: CloudActionExecutorDeps): Promise<HostActionResult> {
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
  if (action.method === 'git.push' && deps.prompts && deps.subscribers) {
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
            detail: `${params.remote ?? 'origin'} ${branch} ${(params.args ?? []).join(' ')}`.trim(),
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
        return { exitCode: make.exitCode, stdout: '', stderr: `bundle create failed: ${make.stderr || make.stdout}` };
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
      return {
        exitCode: push.exitCode ?? 1,
        stdout: push.stdout ?? '',
        stderr: push.stderr ?? '',
      };
    }
    // git.fetch: host fetches origin, bundles, uploads, sandbox fetches.
    const remote = params.remote ?? 'origin';
    const hostFetch = await execa('git', ['-C', lookup.workspacePath, 'fetch', remote], { reject: false });
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
    await backend
      .exec(handle, `rm -f ${shellQuote(remoteBundle)}`)
      .catch(() => {
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
