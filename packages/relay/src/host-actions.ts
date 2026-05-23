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
import type { CloudBackend } from '@agentbox/core';
import { findBox, readState } from '@agentbox/sandbox-core';
import { askPrompt, type PendingPrompts, type PromptSubscribers } from './prompts.js';
import type { GitRpcParams, HostAction, HostActionResult } from './types.js';

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
  return {
    exitCode: 1,
    stdout: '',
    stderr: `host executor for '${action.method}' is not yet supported for cloud boxes\n`,
  };
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
    const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, {
      kind: 'confirm',
      message: `Allow git push from cloud box ${deps.boxName ?? deps.boxId}?`,
      detail: `${params.remote ?? 'origin'} ${branch} ${(params.args ?? []).join(' ')}`.trim(),
      defaultAnswer: 'n',
      context: {
        command: 'git push',
        cwd: containerPath,
        argv: params.args,
      },
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
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
