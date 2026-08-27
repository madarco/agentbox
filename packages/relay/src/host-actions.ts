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
import { toHttpsUrl } from './git-pat.js';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isResolvedBranch,
  isScratchBranch,
  isSanctionedPushBranch,
  landRefspec,
  parseDownloadKind,
  realpathSafe,
  remoteTrackingRef,
  resolveHostPath,
  resolveLandDest,
  resolveRemote,
  sanitizeGitArgs,
  upstreamRef,
} from '@agentbox/core';
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import {
  findBox,
  hostOpenCommand,
  isSupportedApiVersion,
  pluginForProvider,
  readState,
} from '@agentbox/sandbox-core';
import {
  checkoutGuards,
  ghDestructiveTarget,
  ghRunContext,
  ghVerbArgv,
  injectPrCreateHead,
  PR_CREATE_NO_HEAD_REFUSAL,
  prCreateNeedsHead,
  refuseBlockedGhCall,
  refuseCheckoutByDefault,
  refuseGhApiInput,
  resolveGhTarget,
  runHostGh,
  type GhExecRpcParams,
} from './gh.js';
import { hashRpcParams, type HostInitiatedTokens } from './host-initiated.js';
import { buildCpArgv, cpFlags, normalizeCpParams, type CpMethod } from './cp-rpc.js';
import { askPrompt, type PendingPrompts, type PromptSubscribers } from './prompts.js';
import {
  isValidToolName,
  loadGrantedTools,
  resolveProjectToolsFile,
  writeToolGrant,
} from '@agentbox/config';
import {
  argvIsExplicitlyAllowed,
  hostToolInstalled,
  refuseCredentialArgv,
  refuseDeniedArgv,
  refuseIfGhDisabled,
  renderToolList,
  renderToolListJson,
  resolveToolGrant,
  runGrantedTool,
  toolRequestsEnabled,
} from './host-tools.js';
import { canAutoApproveTransfer } from './safe-transfer.js';
import type {
  CheckpointRpcParams,
  CpRpcParams,
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
  /**
   * Mirrors `box.autoApproveSafeHostActions` from the registration (default
   * on). When not `false`, the SAFE subset of host actions auto-resolves; only
   * an explicit `false` restores the always-prompt behavior. Undefined is
   * treated as enabled so callers that don't know the flag stay relaxed.
   */
  autoApproveSafeHostActions?: boolean;
  /**
   * The box's REGISTERED origin URL (`BoxRegistration.originUrl`). Two uses:
   * pushing from a scratch repo when this host has no working checkout for the
   * box (the control-box case — the create worker's clone is a temp dir it
   * deletes), and picking which GitHub host the `gh` proxy points at
   * (`resolveGhTarget`, for GitHub Enterprise Server repos).
   *
   * It must come from the registration, never from the box: the box could
   * rewrite its own `origin`, and either pushing to an attacker-chosen URL with
   * the host's credential helper attached or aiming the host's authenticated
   * `gh` at an attacker-chosen instance would hand over the token. Same
   * invariant the lease path states in `lease.ts`.
   */
  originUrl?: string;
  /** Best-effort logger. */
  log?: (line: string) => void;
}

/**
 * Host-side loader for the built-in cloud backends, injected by whichever
 * bundle owns this relay process.
 *
 * ## Why this is injected rather than imported
 *
 * The relay can't depend on the `@agentbox/sandbox-*` packages: that would
 * close a `sandbox-daytona → sandbox-cloud → sandbox-docker → relay` cycle in
 * the package.json deps. It used to reach them with a computed dynamic import
 * (`'@agentbox/sandbox-' + 'daytona'`) on the theory that esbuild would
 * constant-fold and inline the package. It does not — esbuild never bundles
 * `import(pkg)`, so the specifier stayed a runtime `node_modules` lookup. That
 * works in the pnpm dev tree (workspace symlinks) and fails on every npm
 * install, where the `@agentbox/*` packages are devDependencies bundled into
 * the CLI and therefore absent from `node_modules` entirely.
 *
 * So each bundle that hosts a relay registers a loader built from ITS OWN
 * literal-specifier provider map (the maps are already inlined there):
 *   - the CLI's spawned relay bin — `AGENTBOX_CLOUD_BACKENDS` points at
 *     `apps/cli/dist/cloud-backends.js`, side-loaded lazily in `bin.ts`.
 *   - the hub / control box — `apps/hub/server.ts` registers in-process
 *     before starting the daemon.
 *
 * `resolveBackend` returns `null` for anything it doesn't own (plugins,
 * `docker`), so the plugin registry stays the single gated path for external
 * providers.
 */
export interface CloudBackendLoader {
  /** Stable marker for logs + the build-time wiring check. */
  id?: string;
  /** Resolve a BUILT-IN backend; `null` means "not mine — keep looking". */
  resolveBackend(name: string): Promise<CloudBackend | null>;
  /** The `@agentbox/sandbox-cloud` cp helpers used by the download executor. */
  loadCloudCp(): Promise<CloudCpModule>;
}

let cloudBackendLoader: CloudBackendLoader | undefined;

/**
 * Register (or clear, with `undefined`) the host's built-in backend loader.
 * Must run before the relay starts serving — `startCloudKeepaliveLoop` caches a
 * failed resolve per backend name for the process lifetime.
 */
export function setCloudBackendLoader(loader: CloudBackendLoader | undefined): void {
  cloudBackendLoader = loader;
  cloudCpModule = undefined;
}

/**
 * Lazy backend resolver, in precedence order:
 *   1. the injected loader (built-ins, from the host bundle),
 *   2. the legacy bare-specifier import — only resolves in the pnpm dev tree or
 *      for a standalone embedder that installed the packages itself,
 *   3. the plugin registry (external providers, imported by absolute path),
 *   4. throw.
 *
 * Built-ins are tried before plugins in both 1 and 2 so a plugin can never
 * shadow a shipped provider name.
 */
export async function resolveCloudBackend(name: string): Promise<CloudBackend> {
  if (cloudBackendLoader) {
    const injected = await cloudBackendLoader.resolveBackend(name);
    if (injected) return injected;
  }
  // Legacy fallback. The `'@agentbox/sandbox-' + '<name>'` specifiers stay
  // computed so esbuild leaves them alone instead of trying (and failing) to
  // inline a package the relay doesn't depend on. Reached only when no loader
  // was injected — i.e. the dev tree or a standalone embedder.
  if (name === 'daytona') {
    const pkg = '@agentbox/sandbox-' + 'daytona';
    return loadCloudBackend(
      pkg,
      async () => ((await import(pkg)) as { daytonaBackend: CloudBackend }).daytonaBackend,
    );
  }
  if (name === 'hetzner') {
    const pkg = '@agentbox/sandbox-' + 'hetzner';
    return loadCloudBackend(
      pkg,
      async () => ((await import(pkg)) as { hetznerBackend: CloudBackend }).hetznerBackend,
    );
  }
  if (name === 'vercel') {
    const pkg = '@agentbox/sandbox-' + 'vercel';
    return loadCloudBackend(
      pkg,
      async () => ((await import(pkg)) as { vercelBackend: CloudBackend }).vercelBackend,
    );
  }
  if (name === 'e2b') {
    const pkg = '@agentbox/sandbox-' + 'e2b';
    return loadCloudBackend(
      pkg,
      async () => ((await import(pkg)) as { e2bBackend: CloudBackend }).e2bBackend,
    );
  }
  if (name === 'digitalocean') {
    const pkg = '@agentbox/sandbox-' + 'digitalocean';
    return loadCloudBackend(
      pkg,
      async () =>
        ((await import(pkg)) as { digitaloceanBackend: CloudBackend }).digitaloceanBackend,
    );
  }
  if (name === 'remote-docker') {
    const pkg = '@agentbox/sandbox-' + 'remote-docker';
    return loadCloudBackend(
      pkg,
      async () =>
        ((await import(pkg)) as { remoteDockerBackend: CloudBackend }).remoteDockerBackend,
    );
  }
  // External provider plugins: not bundle-inlined, so resolve from the same
  // `~/.agentbox/plugins.json` registry the CLI writes and `import()` the
  // recorded entry with a TRUE variable specifier. The relay runs on the host
  // (same ~/.agentbox), so the registry + the installed package are reachable.
  const plugin = pluginForProvider(name);
  if (plugin) {
    if (!isSupportedApiVersion(plugin.apiVersion)) {
      throw new Error(
        `relay: plugin '${plugin.packageName}' targets provider SDK v${String(plugin.apiVersion)}, which this AgentBox does not support`,
      );
    }
    return loadCloudBackend(plugin.packageName, async () => {
      const mod = (await import(pathToFileURL(plugin.resolvedEntry).href)) as {
        providerModule?: { provider?: { name?: string }; backend?: CloudBackend };
        providerModules?: { provider?: { name?: string }; backend?: CloudBackend }[];
      };
      const all = mod.providerModules ?? (mod.providerModule ? [mod.providerModule] : []);
      // Strict name match — never fall back to all[0] (wrong-backend hazard).
      const pm = all.find((m) => m.provider?.name === name);
      if (!pm?.backend) {
        throw new Error(`plugin '${plugin.packageName}' exposes no cloud backend for '${name}'`);
      }
      return pm.backend;
    });
  }
  throw new Error(`no host executor for cloud backend '${name}'`);
}

/**
 * True for "the module isn't installed" failures. The `code` check is the
 * durable one: Node's ESM resolver says `Cannot find package 'x' imported from
 * y` (ERR_MODULE_NOT_FOUND) while CJS says `Cannot find module` — matching only
 * the CJS wording let the raw ESM error through untranslated.
 */
export function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cannot find (module|package)|MODULE_NOT_FOUND/i.test(msg);
}

/**
 * Run a provider's dynamic import, turning a missing-module failure into the
 * actionable "no loader was injected" error (other errors propagate unchanged).
 * Shared by every branch of `resolveCloudBackend`'s legacy fallback.
 */
async function loadCloudBackend(
  pkg: string,
  load: () => Promise<CloudBackend>,
): Promise<CloudBackend> {
  try {
    return await load();
  } catch (err) {
    if (isModuleNotFound(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `relay: cannot load '${pkg}' at runtime — no cloud-backend loader was injected and the package is not installed next to @agentbox/relay (the @madarco/agentbox CLI injects one via AGENTBOX_CLOUD_BACKENDS; the hub registers one in-process). Original: ${msg}`,
      );
    }
    throw err;
  }
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
  if (action.method === 'gh.exec') {
    return runGhExecRpc(action, deps);
  }
  if (action.method.startsWith('tool.')) {
    return runToolRpc(action, deps);
  }
  if (action.method === 'git.clone' || action.method === 'gh.repo.clone') {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `${action.method}: not yet implemented for this box. Run \`gh\` / \`git\` on the host directly for now.\n`,
    };
  }
  return {
    exitCode: 1,
    stdout: '',
    stderr: `host executor for '${action.method}' is not yet supported for cloud boxes\n`,
  };
}

/**
 * Cloud-side confirm gate for a write op. Mirrors the prompt / no-subscriber
 * handling in `runGhPrRpc` (`AGENTBOX_GH_NO_SUB` deny/allow/prompt). Returns a
 * ready-to-send denial `HostActionResult` to abort, or `null` to proceed.
 */
async function cloudWriteConfirm(
  deps: CloudActionExecutorDeps,
  command: string,
  cwd: string | undefined,
  args: string[],
): Promise<HostActionResult | null> {
  if (!deps.prompts || !deps.subscribers) return null;
  const ctx = {
    kind: 'confirm' as const,
    message: `Allow ${command} from cloud box ${deps.boxName ?? deps.boxId}?`,
    detail: args.join(' ').slice(0, 200),
    defaultAnswer: 'n' as const,
    context: { command, cwd, argv: args },
  };
  const hasSubscriber = deps.subscribers.count(deps.boxId) > 0;
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
      deps.log?.(`${command} auto-approved (no subscribers, AGENTBOX_GH_NO_SUB=allow)`);
      return null;
    }
    const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, ctx, {
      ttlMs: 5 * 60 * 1000,
    });
    return verdict.answer === 'y' ? null : { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
  }
  const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, ctx);
  return verdict.answer === 'y' ? null : { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
}

/**
 * Cloud `gh.exec`. Mirrors `handleGhExecRpc` in server.ts step for step —
 * same blocklist, same destructive-confirm set, same allow-once default — so
 * `gh` behaves identically whichever provider the box runs on. The only
 * difference is the confirm helper: cloud goes through `cloudWriteConfirm`,
 * which carries the no-subscriber fallback every gated cloud action shares.
 */
async function runGhExecRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const params = (action.params ?? {}) as GhExecRpcParams;
  const args = Array.isArray(params.args)
    ? params.args.filter((a): a is string => typeof a === 'string')
    : [];
  if (args.length === 0) {
    return { exitCode: 64, stdout: '', stderr: 'gh: no arguments\n' };
  }

  const blocked = refuseBlockedGhCall(args);
  if (blocked) return blocked;

  const verb = ghVerbArgv(args);
  const family = verb[0] ?? '';
  const op = verb[1] ?? '';
  if (family === 'pr') {
    const checkoutOptIn = refuseCheckoutByDefault(op);
    if (checkoutOptIn) return checkoutOptIn;
  }
  if (family === 'api') {
    const inputRefusal = refuseGhApiInput(args);
    if (inputRefusal) return inputRefusal;
  }

  const ghTarget = await resolveGhTarget(deps.originUrl);
  if (ghTarget.error) return ghTarget.error;
  const lookup = await lookupCloudBox(deps.boxId);

  const ghRevoked = await refuseIfGhDisabled(lookup.workspacePath);
  if (ghRevoked) return ghRevoked;

  if (family === 'pr' && op === 'checkout') {
    // Same guard the docker path applies: never check the host repo out onto
    // a branch a box occupies, and never over a dirty tree.
    const branches = lookup.sanctionedBranch ? [lookup.sanctionedBranch] : [];
    const guard = await checkoutGuards(lookup.workspacePath, branches);
    if (guard) return guard;
  }

  // Host-initiated calls carry a scope- and params-hash-bound one-time token.
  // A present-but-invalid token is a hard reject — an attack signal, not a
  // retry — and this must hold on cloud too, not just docker.
  const tokenClaimed = typeof params.hostInitiated === 'string';
  const hostInitiatedOk =
    tokenClaimed &&
    (deps.hostInitiatedTokens?.consume(
      params.hostInitiated,
      deps.boxId,
      'gh.exec',
      hashRpcParams(params),
    ) ??
      false);
  if (tokenClaimed && !hostInitiatedOk) {
    return {
      exitCode: 10,
      stdout: '',
      stderr: 'host-initiated token rejected: invalid, expired, or bound to different params\n',
    };
  }

  const destructive = ghDestructiveTarget(args);
  if (!hostInitiatedOk && (destructive || deps.autoApproveSafeHostActions === false)) {
    const label = destructive
      ? `gh ${args.slice(0, 2).join(' ')} (destroys a ${destructive})`
      : `gh ${args.slice(0, 2).join(' ')}`;
    const denied = await cloudWriteConfirm(deps, label.trim(), params.path, [...args]);
    if (denied) return denied;
  }

  let finalArgs = args;
  if (family === 'pr') {
    const head = args.slice(0, args.length - verb.length);
    const rest = injectPrCreateHead(op, lookup.sanctionedBranch, verb.slice(2));
    if (prCreateNeedsHead(op, rest)) return PR_CREATE_NO_HEAD_REFUSAL;
    finalArgs = [...head, family, op, ...rest];
  }
  const run = ghRunContext(lookup.workspacePath, deps.originUrl, finalArgs);
  return runHostGh(run.args, run.cwd, { host: ghTarget.host });
}

/**
 * Cloud `tool.*` executor. Mirrors `handleToolRpc` in server.ts step for
 * step — same grant lookup, same built-in credential deny list, same
 * per-tool rules, same gate — so a host tool behaves identically whichever
 * provider the box runs on. The only difference is the confirm helper:
 * cloud goes through `cloudWriteConfirm`, which carries the no-subscriber
 * fallback every gated cloud action shares.
 */
async function runToolRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const params = (action.params ?? {}) as Record<string, unknown>;
  const containerPath = typeof params['path'] === 'string' ? params['path'] : '/workspace';
  const lookup = await lookupCloudBox(deps.boxId);
  const cwd = lookup.workspacePath;

  if (action.method === 'tool.list') {
    const grants = await loadGrantedTools(cwd);
    const json = params['format'] === 'json';
    return {
      exitCode: 0,
      stdout: json ? renderToolListJson(grants.values()) : renderToolList(grants.values()),
      stderr: '',
    };
  }

  const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
  if (!name || !isValidToolName(name)) {
    return { exitCode: 64, stdout: '', stderr: `${action.method}: missing or invalid tool name\n` };
  }

  if (action.method === 'tool.request') {
    if (!(await toolRequestsEnabled(cwd))) {
      return {
        exitCode: 65,
        stdout: '',
        stderr:
          'host-tool requests are disabled for this project ' +
          '(`agentbox config set --project tools.request.enabled true` to allow them)\n',
      };
    }
    const existing = await loadGrantedTools(cwd);
    if (existing.has(name)) {
      return { exitCode: 0, stdout: `${name} is already granted\n`, stderr: '' };
    }
    if (!(await hostToolInstalled(name))) {
      return {
        exitCode: 127,
        stdout: '',
        stderr: `${name} is not installed on the host — nothing to grant\n`,
      };
    }
    const reason = typeof params['reason'] === 'string' ? params['reason'].slice(0, 500) : '';
    const denied = await cloudWriteConfirm(
      deps,
      `tool request ${name}`,
      containerPath,
      reason ? [name, `reason: ${reason}`] : [name],
    );
    if (denied) return denied;
    await writeToolGrant(await resolveProjectToolsFile(cwd), {
      name,
      bin: name,
      source: 'request',
      approvedAt: new Date().toISOString(),
    });
    return { exitCode: 0, stdout: `${name} granted for this project\n`, stderr: '' };
  }

  if (action.method !== 'tool.run') {
    return { exitCode: 64, stdout: '', stderr: `unknown tool method: ${action.method}\n` };
  }

  const resolved = await resolveToolGrant(name, cwd);
  if ('refusal' in resolved) return resolved.refusal;
  const grant = resolved.grant;

  const args = Array.isArray(params['args'])
    ? (params['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  const credRefusal = refuseCredentialArgv(name, args, grant.bin);
  if (credRefusal) return credRefusal;
  const denyRefusal = refuseDeniedArgv(grant, args);
  if (denyRefusal) return denyRefusal;

  const silent = argvIsExplicitlyAllowed(grant, args) || deps.autoApproveSafeHostActions !== false;
  if (!silent) {
    const denied = await cloudWriteConfirm(deps, `tool ${name}`, containerPath, [...args]);
    if (denied) return denied;
  }

  return runGrantedTool(grant, args, cwd);
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
      // Open on the host's default handler (`open` on macOS, `xdg-open` on
      // Linux). Spawn detached so the relay loop isn't blocked; the box never
      // observes the outcome.
      const { spawn } = await import('node:child_process');
      const child = spawn(hostOpenCommand(), [url], { stdio: 'ignore', detached: true });
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
  /**
   * Branch the host has sanctioned for this box's pushes (defaults to the
   * create-time `workspaceBranch`). The push gate auto-approves a push only to
   * a scratch branch or this value.
   */
  sanctionedBranch?: string;
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
  return {
    workspacePath: hit.box.workspacePath,
    cloudSandboxId: sid,
    sanctionedBranch: hit.box.cloud?.sanctionedBranch ?? hit.box.cloud?.workspaceBranch,
  };
}

/**
 * The box's registered host workspace (the host dir that mirrors `/workspace`),
 * used as the base for resolving relative host paths in `cp`/`download` RPCs.
 * Returns `undefined` when the box isn't in state. Shared by the docker
 * (server.ts) and cloud handlers so a relative host path never silently
 * resolves against the long-lived relay daemon's CWD (which is arbitrary — one
 * relay serves many boxes/projects).
 */
export async function boxWorkspacePath(boxId: string): Promise<string | undefined> {
  const state = await readState();
  const hit = findBox(boxId, state);
  return hit.kind === 'ok' ? hit.box.workspacePath : undefined;
}

/**
 * The realpath'd host source paths this box already approved via its `carry:`
 * block, so the cp auto-approve gate can exempt a secret file that the user
 * already consented to copy in at create time. Best-effort: empty set on any
 * read failure (→ secret files fall back to prompting). Shared by the docker
 * and cloud cp handlers.
 */
export async function boxCarriedHostPaths(boxId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const state = await readState();
    const hit = findBox(boxId, state);
    const entries = hit.kind === 'ok' ? hit.box.carry?.entries : undefined;
    for (const e of entries ?? []) out.add(await realpathSafe(e.src));
  } catch {
    /* best-effort */
  }
  return out;
}

// resolveHostPath's pure decision moved to `@agentbox/core`'s sync/files.ts.
// Re-exported here so `server.ts` (and the cp/download call sites below) keep
// importing it from `./host-actions.js` unchanged.
export { resolveHostPath };

/**
 * The `@agentbox/sandbox-cloud` cp helpers the download executor needs. Kept
 * out of the relay bundle for the same dependency-cycle reason as the provider
 * backends — the injected `CloudBackendLoader` supplies them; the computed
 * specifier below is the same dev-tree-only fallback.
 */
export interface CloudCpModule {
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
  if (cloudBackendLoader) {
    cloudCpModule = await cloudBackendLoader.loadCloudCp();
    return cloudCpModule;
  }
  // Legacy fallback — see resolveCloudBackend.
  const pkg = '@agentbox/sandbox-' + 'cloud';
  try {
    const mod = (await import(pkg)) as CloudCpModule;
    cloudCpModule = mod;
    return mod;
  } catch (err) {
    if (isModuleNotFound(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `relay: cannot load '${pkg}' at runtime — no cloud-backend loader was injected and the package is not installed next to @agentbox/relay (the @madarco/agentbox CLI injects one via AGENTBOX_CLOUD_BACKENDS; the hub registers one in-process). Original: ${msg}`,
      );
    }
    throw err;
  }
}

async function runCpRpc(
  action: HostAction,
  deps: CloudActionExecutorDeps,
): Promise<HostActionResult> {
  const method = action.method as CpMethod;
  const params = (action.params ?? {}) as CpRpcParams;
  let norm: { sources: string[]; dest: string };
  try {
    norm = normalizeCpParams(method, params);
  } catch (err) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: 'relay: AGENTBOX_CLI_ENTRY not set; cannot run cp host-side\n',
    };
  }
  const direction = method === 'cp.toHost' ? 'box -> host' : 'host -> box';
  // Resolve host paths against THIS box's workspace so a relative path doesn't
  // land under the relay daemon's CWD (which belongs to whichever project
  // started the relay), and so the consent prompt shows the real destination.
  const lookup = await lookupCloudBox(deps.boxId);
  const boxName = deps.boxName ?? deps.boxId;
  const {
    argv: cpArgs,
    detail,
    contextArgv,
  } = buildCpArgv({
    method,
    boxName,
    sources: norm.sources,
    dest: norm.dest,
    resolveHost: (p) => resolveHostPath(lookup.workspacePath, p),
    flags: cpFlags(params),
  });
  // Same askPrompt UX as docker's /rpc handler — keeps the in-box agent from
  // pulling host files / scattering box files without explicit consent. A
  // transfer contained in the box project folder (non-secret for host->box)
  // auto-approves under the safe flag, mirroring the docker handler.
  const cpHostPaths =
    method === 'cp.toHost'
      ? [resolveHostPath(lookup.workspacePath, norm.dest)]
      : norm.sources.map((s) => resolveHostPath(lookup.workspacePath, s));
  const cpAuto = await canAutoApproveTransfer({
    enabled: deps.autoApproveSafeHostActions !== false,
    workspacePath: lookup.workspacePath,
    hostPaths: cpHostPaths,
    checkSecret: method === 'cp.fromHost',
    carried: method === 'cp.fromHost' ? await boxCarriedHostPaths(deps.boxId) : undefined,
  });
  if (cpAuto) {
    deps.prompts?.noteAutoApprove(
      deps.boxId,
      {
        kind: 'confirm',
        message: `cp (${direction}) on ${boxName}`,
        detail,
        context: { command: method, argv: contextArgv },
      },
      method === 'cp.toHost' ? 'safe: contained copy to host' : 'safe: contained copy from host',
    );
  } else if (deps.prompts && deps.subscribers) {
    const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, {
      kind: 'confirm',
      message: `Allow cp (${direction}) on ${boxName}?`,
      detail,
      defaultAnswer: 'n',
      context: { command: method, argv: contextArgv },
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
    }
  }
  // Converge on the docker path: re-shell the installed `agentbox cp`. Its
  // `isCloud` branch routes to the cloud provider's uploadPath/downloadPath, so
  // excludes, the size guard, and provider routing are honored identically to a
  // host-typed `agentbox cp` (the old direct-primitive path silently dropped
  // them). cwd = the box workspace makes project-config lookup box-correct.
  const argv = [process.execPath, entry, ...cpArgs];
  const result = await execa(argv[0]!, argv.slice(1), {
    reject: false,
    cwd: lookup.workspacePath,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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
  // Vercel checkpoints stop + reboot the box: `sb.snapshot()` powers off the
  // microVM (resume is lazy on the next SDK call). When an interactive wrapper
  // is attached, warn + require confirmation before we yank the box out from
  // under it. Other backends snapshot without stopping (docker `docker commit`,
  // hetzner no-pause, daytona), so they stay prompt-free. No attached wrapper →
  // proceed (a headless caller already knows the box will reboot).
  if (
    deps.backendName === 'vercel' &&
    deps.autoApproveSafeHostActions === false &&
    deps.prompts &&
    deps.subscribers &&
    deps.subscribers.count(deps.boxId) > 0
  ) {
    const verdict = await askPrompt(deps.prompts, deps.subscribers, deps.boxId, {
      kind: 'confirm',
      message: `Create checkpoint on ${deps.boxName ?? deps.boxId}? The vercel box will stop and reboot.`,
      detail: params.name ? `checkpoint: ${params.name}` : '(auto-named)',
      defaultAnswer: 'n',
      context: { command: 'checkpoint create', argv: params.name ? [params.name] : [] },
    });
    if (verdict.answer !== 'y') {
      return { exitCode: 10, stdout: '', stderr: 'checkpoint denied by user\n' };
    }
  } else if (
    deps.backendName === 'vercel' &&
    deps.subscribers &&
    deps.subscribers.count(deps.boxId) > 0
  ) {
    // Checkpoint is a safe subset op (the box's own snapshot); audit the
    // reboot-causing auto-approval so it's still visible in the event feed.
    deps.prompts?.noteAutoApprove(
      deps.boxId,
      {
        kind: 'confirm',
        message: `checkpoint create on ${deps.boxName ?? deps.boxId} (vercel box will stop and reboot)`,
        detail: params.name ? `checkpoint: ${params.name}` : '(auto-named)',
        context: { command: 'checkpoint create', argv: params.name ? [params.name] : [] },
      },
      'safe: checkpoint create',
    );
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
  const kind = parseDownloadKind(action.method);
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
  const lookup = await lookupCloudBox(deps.boxId);
  // params.hostPath is reserved in the wire shape; v1 lands /workspace under
  // box.workspacePath (the host project root), matching docker's default. A
  // relative override resolves against the box workspace, not the relay's CWD.
  const hostDst =
    typeof params.hostPath === 'string' && params.hostPath.length > 0
      ? resolveHostPath(lookup.workspacePath, params.hostPath)
      : lookup.workspacePath;
  // Auto-approve when the destination stays inside the box project folder
  // (the default does); an escaping override still prompts.
  const dlAuto = await canAutoApproveTransfer({
    enabled: deps.autoApproveSafeHostActions !== false,
    workspacePath: lookup.workspacePath,
    hostPaths: [hostDst],
    checkSecret: false,
  });
  if (dlAuto) {
    deps.prompts?.noteAutoApprove(
      deps.boxId,
      {
        kind: 'confirm',
        message: `download (${kind}) from ${deps.boxName ?? deps.boxId}`,
        detail: params.hostPath ?? '(default host location)',
        context: { command: action.method, argv: params.hostPath ? [params.hostPath] : [] },
      },
      'safe: contained download',
    );
  } else if (deps.prompts && deps.subscribers) {
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
  const backend = await resolveCloudBackend(deps.backendName);
  const handle: CloudHandle = { sandboxId: lookup.cloudSandboxId };
  const cp = await loadCloudCp();
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
/**
 * Where the host runs its half of a git RPC, and what it pushes to.
 *
 * On a laptop this is the user's real checkout: `dir` is the working copy and
 * `remote` is whatever `origin` resolves to there. On a **control box** there is
 * no checkout at all — the create worker clones into a temp dir and deletes it
 * in a `finally` — so `dir` is a throwaway repo we initialize per call and
 * `remote` is the registered origin URL.
 *
 * A scratch repo is enough because `git bundle create <file> <branch>` is
 * self-contained: it carries the branch's full history with no prerequisites, so
 * unbundling into an empty repo yields a pushable ref. Nothing needs to persist
 * between pushes, which is why the hub keeps no per-project clones.
 */
export interface HostGitRepo {
  dir: string;
  /** Explicit push target — a URL for scratch repos, else the caller's remote name. */
  remote: string;
  scratch: boolean;
  cleanup: () => Promise<void>;
}

/**
 * The push URL a scratch (checkout-less) host repo should use. SSH/scp remotes
 * are rewritten to plain HTTPS; anything already HTTPS — or any URL shape
 * `toHttpsUrl` can't parse — is passed through untouched, so an unusual remote
 * fails at git with its own message instead of here.
 */
function httpsOriginForScratchPush(origin: string): string {
  if (/^https?:\/\//i.test(origin)) return origin;
  try {
    return toHttpsUrl(origin);
  } catch {
    return origin;
  }
}

export async function resolveHostGitRepo(
  workspacePath: string,
  deps: CloudActionExecutorDeps,
  remoteName: string,
): Promise<HostGitRepo> {
  if (workspacePath.length > 0 && existsSync(workspacePath)) {
    return {
      dir: workspacePath,
      remote: remoteName,
      scratch: false,
      cleanup: () => Promise.resolve(),
    };
  }
  // No host checkout. Only the REGISTERED origin can be trusted as a push
  // target — see the `originUrl` doc on CloudActionExecutorDeps.
  const rawOrigin = deps.originUrl?.trim() ?? '';
  if (rawOrigin.length === 0) {
    throw new Error(
      `host-side git is unavailable for box ${deps.boxId}: its host repo (${workspacePath || '<unset>'}) does not exist ` +
        `and the box has no registered origin URL to push to. Adopt the box on a host with a checkout, or re-register it.`,
    );
  }
  // A checkout-less host is a control box, which authenticates git through a
  // credential helper (`hub.gitAuth=gh`) or an App token — never an SSH key. An
  // scp-form `git@github.com:owner/repo` origin therefore dies at host-key
  // verification before auth is ever consulted, so rewrite it to the HTTPS URL
  // the helper covers. Mirrors the create worker's clone (`hub-worker.ts`),
  // which has always done this — without it the clone side works and the push
  // side fails for every SSH-origin project.
  const origin = httpsOriginForScratchPush(rawOrigin);
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-git-scratch-'));
  const init = await execa('git', ['-C', dir, 'init', '--quiet'], { reject: false });
  if ((init.exitCode ?? 1) !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`could not initialize a scratch git repo: ${init.stderr ?? ''}`);
  }
  return {
    dir,
    remote: origin,
    scratch: true,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

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
  if (branchProbe.exitCode !== 0 || !isResolvedBranch(branch)) {
    return {
      exitCode: branchProbe.exitCode || 1,
      stdout: '',
      stderr: `failed to resolve branch in sandbox ${containerPath}: ${branchProbe.stderr || branch}`,
    };
  }

  // Host-only landing: copy the box's branch into the host's *local* repo
  // (no remote push, nothing published). This is the push flow's bundle
  // pull-back steps without the final `git push` — so it skips the confirm
  // gate below entirely. Destination defaults to the box's branch name.
  if (params.hostOnly) {
    // Unlike push/fetch, this one has nowhere to go without a real checkout —
    // its whole purpose is to leave the branch in the host's repo. A scratch
    // repo we delete would be a no-op dressed up as a success.
    if (lookup.workspacePath.length === 0 || !existsSync(lookup.workspacePath)) {
      return {
        exitCode: 64,
        stdout: '',
        stderr:
          `--host-only is unavailable for box ${deps.boxId}: this host has no working copy of the project ` +
          `(${lookup.workspacePath || '<unset>'} does not exist). Boxes created by a control box have no host ` +
          `checkout — push to the remote instead, or adopt the box on a machine that has one.\n`,
      };
    }
    const dest = resolveLandDest(branch, params.as);
    const stageSave = await mkdtemp(join(tmpdir(), 'agentbox-git-save-'));
    const hostBundleSave = join(stageSave, 'op.bundle');
    const remoteBundleSave = '/tmp/agentbox-rpc-save.bundle';
    try {
      const make = await backend.exec(
        handle,
        `git -C ${shellQuote(containerPath)} bundle create ${shellQuote(remoteBundleSave)} ${shellQuote(branch)}`,
      );
      if (make.exitCode !== 0) {
        return {
          exitCode: make.exitCode,
          stdout: '',
          stderr: `bundle create failed: ${make.stderr || make.stdout}`,
        };
      }
      await backend.downloadFile(handle, remoteBundleSave, hostBundleSave);
      const refspec = landRefspec(branch, dest, params.force);
      const landed = await execa(
        'git',
        ['-C', lookup.workspacePath, 'fetch', hostBundleSave, refspec],
        { reject: false },
      );
      if ((landed.exitCode ?? 1) !== 0) {
        return {
          exitCode: landed.exitCode ?? 1,
          stdout: landed.stdout ?? '',
          stderr: `host git fetch from bundle failed: ${landed.stderr ?? ''}`,
        };
      }
      return {
        exitCode: 0,
        stdout: `branch ${dest} available in ${lookup.workspacePath}\n${landed.stdout ?? ''}`,
        stderr: landed.stderr ?? '',
      };
    } finally {
      await rm(stageSave, { recursive: true, force: true });
      await backend.exec(handle, `rm -f ${shellQuote(remoteBundleSave)}`).catch(() => {
        /* best-effort */
      });
    }
  }

  // Gate `git.push` (and only `git.push`) behind the same host-side confirm
  // prompt the Docker provider already uses. The wrapper's SSE subscriber on
  // /admin/prompts/stream surfaces it as a footer y/N; `askPrompt` returns
  // auto-`y` when AGENTBOX_PROMPT=off (matches Docker behavior).
  // The gate is bypassed for pushes to a *sanctioned* branch: the box's own
  // `agentbox/<name>` scratch branch (always its job), or the branch the host
  // last put the box on (`sanctionedBranch`). A scratch push bypasses
  // unconditionally; the sanctioned-but-non-scratch bypass is part of the safe
  // subset, so it honors `box.autoApproveSafeHostActions` and leaves an audit
  // trail. An agent that self-switches HEAD to another branch still prompts.
  const isScratch = isScratchBranch(branch);
  const safeApproveOn = deps.autoApproveSafeHostActions !== false;
  const isSanctionedNonScratch =
    !isScratch && safeApproveOn && isSanctionedPushBranch(branch, lookup.sanctionedBranch);
  const bypassPushGate = isScratch || isSanctionedNonScratch;
  if (action.method === 'git.push' && isSanctionedNonScratch) {
    deps.prompts?.noteAutoApprove(
      deps.boxId,
      {
        kind: 'confirm',
        message: `git push to sanctioned branch ${branch} on ${deps.boxName ?? deps.boxId}`,
        context: { command: 'git push', cwd: containerPath, argv: params.args },
      },
      'safe: sanctioned-branch push',
    );
  }
  // Host-initiated pushes (driven by `agentbox git push <box>`) skip the
  // confirm prompt — but only with a valid scope-matched, params-hash-bound
  // one-time token. If a token is *present* but invalid (mutated args,
  // replayed, expired), reject hard: that's an attack signal. Only fall
  // through to the prompt when no token was claimed.
  const tokenClaimedGit = typeof params.hostInitiated === 'string';
  const incomingHashGit = hashRpcParams(params);
  const hostInitiatedOk =
    !bypassPushGate &&
    tokenClaimedGit &&
    (deps.hostInitiatedTokens?.consume(
      params.hostInitiated,
      deps.boxId,
      'git.push',
      incomingHashGit,
    ) ??
      false);
  if (action.method === 'git.push' && !bypassPushGate && tokenClaimedGit && !hostInitiatedOk) {
    return {
      exitCode: 10,
      stdout: '',
      stderr: 'host-initiated token rejected: invalid, expired, or bound to different params\n',
    };
  }
  if (
    action.method === 'git.push' &&
    !bypassPushGate &&
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
    const hasSubscriber = deps.subscribers.count(deps.boxId) > 0;
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
              `${resolveRemote(params.remote)} ${branch} ${(params.args ?? []).join(' ')}`.trim(),
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
        detail: `${resolveRemote(params.remote)} ${branch} ${(params.args ?? []).join(' ')}`.trim(),
        defaultAnswer: 'n',
        context: { command: 'git push', cwd: containerPath, argv: params.args },
      });
      if (verdict.answer !== 'y') {
        return { exitCode: 10, stdout: '', stderr: 'denied by user\n' };
      }
    }
  }

  const remoteName = resolveRemote(params.remote);
  let repo: HostGitRepo;
  try {
    repo = await resolveHostGitRepo(lookup.workspacePath, deps, remoteName);
  } catch (err) {
    return {
      exitCode: 64,
      stdout: '',
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
  if (repo.scratch) {
    deps.log?.(
      `git.${action.method === 'git.push' ? 'push' : 'fetch'}: no host checkout for box ${deps.boxId}; using a scratch repo against ${repo.remote}`,
    );
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
      //    In a scratch repo this is what materializes the branch at all.
      const fetch = await execa(
        'git',
        ['-C', repo.dir, 'fetch', hostBundle, `${branch}:${branch}`],
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
      // <args>`); pass them through to git on the host. `repo.remote` is the
      // caller's remote name against a real checkout, or the registered origin
      // URL when we're pushing out of a scratch repo (which has no remotes).
      const remote = repo.remote;
      const argv = ['-C', repo.dir, 'push', remote, branch];
      argv.push(...sanitizeGitArgs(params.args));
      const push = await execa('git', argv, { reject: false });
      let pushStderr = push.stderr ?? '';
      // After a successful push, sync the box's view of origin to match what
      // a normal local `git push -u` would have left behind: write the pushed
      // tip into the box's `refs/remotes/origin/<branch>` and set the branch
      // upstream to track it. Without this, Claude Code's PR badge sees no
      // upstream on the branch and doesn't fetch / display the PR. Per-box
      // scratch branches (`agentbox/<name>`) skip the sync — they're
      // local-only by design.
      if ((push.exitCode ?? 1) === 0 && !isScratchBranch(branch)) {
        try {
          const sha = await execa('git', ['-C', repo.dir, 'rev-parse', branch], { reject: false });
          const shaText = (sha.stdout ?? '').trim();
          if (sha.exitCode === 0 && shaText.length > 0) {
            // These are refs INSIDE the box, so they must use the remote NAME —
            // `repo.remote` may be a bare URL when we pushed from a scratch repo.
            const updateRef = await backend.exec(
              handle,
              `git -C ${shellQuote(containerPath)} update-ref ${remoteTrackingRef(remoteName, branch)} ${shellQuote(shaText)}`,
            );
            if (updateRef.exitCode !== 0) {
              pushStderr += `\nrelay: post-push in-box update-ref ${remoteTrackingRef(remoteName, branch)} failed: ${updateRef.stderr || updateRef.stdout}`;
            }
            const setUpstream = await backend.exec(
              handle,
              `git -C ${shellQuote(containerPath)} branch --set-upstream-to=${upstreamRef(remoteName, branch)} ${shellQuote(branch)}`,
            );
            if (setUpstream.exitCode !== 0) {
              pushStderr += `\nrelay: post-push in-box --set-upstream-to=${upstreamRef(remoteName, branch)} failed: ${setUpstream.stderr || setUpstream.stdout}`;
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
    // A scratch repo has no configured remote, so fetch the registered URL
    // straight into the remote-tracking namespace the bundle step reads back.
    const fetchArgs = repo.scratch
      ? ['-C', repo.dir, 'fetch', repo.remote, '+refs/heads/*:refs/remotes/origin/*', '--tags']
      : ['-C', repo.dir, 'fetch', repo.remote];
    const hostFetch = await execa('git', fetchArgs, { reject: false });
    if (hostFetch.exitCode !== 0) {
      return {
        exitCode: hostFetch.exitCode ?? 1,
        stdout: hostFetch.stdout ?? '',
        stderr: `host git fetch failed: ${hostFetch.stderr ?? ''}`,
      };
    }
    // Bundle origin's remote-tracking refs so the sandbox sees the updates.
    const bundle = await execa('git', ['-C', repo.dir, 'bundle', 'create', hostBundle, `--all`], {
      reject: false,
    });
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
    await repo.cleanup().catch(() => {
      /* best-effort */
    });
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
