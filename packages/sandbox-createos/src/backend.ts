import { createHash } from 'node:crypto';

import type {
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@agentbox/core';
import type { createCloudProvider } from '@agentbox/sandbox-cloud';
import { quoteShellArgv } from '@agentbox/sandbox-cloud';
import { CreateOsApiError, makeCreateOsClient, type CreateOsSandboxView } from './client.js';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';
import { withCreateOsRetry } from './retry.js';

export const CREATEOS_DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';
export const CREATEOS_DEFAULT_RESOURCES = { cpu: 2, memory: 2, disk: 20 } as const;

/**
 * Ownership marker stamped into the sandbox's persistent env map at create
 * time. The CreateOS API returns env KEYS (never values) on the sandbox view,
 * which makes this the one create-time field we can both set and read back —
 * CreateOS has no tags/labels/metadata primitive the way vercel and e2b do.
 * `list()` filters on it so `agentbox prune` can never offer a sandbox the user
 * created through CreateOS itself as a deletion candidate.
 */
const OWNED_ENV_KEY = 'AGENTBOX_OWNED';

const DEFAULT_SHAPE = 's-2vcpu-2gb';
const DEFAULT_ROOTFS = 'devbox:1';
const DEFAULT_DISK_MIB = 20_480;
const CREATEOS_WEB_PORT = 8080;
const CREATEOS_SANDBOX_NAME_MAX_LENGTH = 22;

export function createosSandboxName(name: string): string {
  if (name.length <= CREATEOS_SANDBOX_NAME_MAX_LENGTH) return name;

  const boxIdSuffix = /(-b[0-9a-f]{8})$/.exec(name)?.[1];
  const suffix = boxIdSuffix ?? `-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
  return `${name.slice(0, CREATEOS_SANDBOX_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function mapState(status: string | undefined): CloudState {
  switch (status) {
    case 'running':
    case 'creating':
    case 'resuming':
      return 'running';
    case 'paused':
    case 'pausing':
      return 'paused';
    // `error` is CreateOS's "resume exhausted RESUME_MAX_HOSTS; user can retry"
    // state, not a tombstone: the service accepts resume from it and clears the
    // failed flag (fc pause_handlers.go). Mapping it to `missing` presented a
    // recoverable box as deleted. `failed`/`destroyed` are the terminal ones.
    case 'error':
      return 'paused';
    case 'destroyed':
    case 'destroying':
    case 'failed':
      return 'missing';
    default:
      return 'missing';
  }
}

export function parseCreateosSize(spec: string | undefined): {
  shape: string;
  resources?: { cpu?: number; memory?: number; disk?: number };
} {
  const trimmed = (spec ?? '').trim();
  if (!trimmed) return { shape: DEFAULT_SHAPE, resources: { ...CREATEOS_DEFAULT_RESOURCES } };
  const m = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (!m) return { shape: trimmed };
  const cpu = Number(m[1]);
  const memory = Number(m[2]);
  const disk = m[3] ? Number(m[3]) : 20;
  return { shape: `s-${String(cpu)}vcpu-${String(memory)}gb`, resources: { cpu, memory, disk } };
}

function rootfsFor(req: CloudProvisionRequest): string {
  const image = req.snapshot ?? req.image;
  if (!image || image === CREATEOS_DEFAULT_BOX_IMAGE_REF) return DEFAULT_ROOTFS;
  return image;
}

/**
 * `--size 4-8-50` must win over the provider default. `req.resources` is NOT a
 * user signal here — the shared cloud scaffold always fills it from
 * `defaultResources`, so it is never undefined and reading it first pinned
 * every box to the default 20 GiB. The parsed `--size` disk is the only
 * explicit request, so it takes precedence; `req.resources.disk` stays the
 * fallback for a bare shape name (`--size s-4vcpu-8gb`), which parses no disk.
 */
function diskMibFor(req: CloudProvisionRequest, parsedDiskGb: number | undefined): number {
  const requested = parsedDiskGb ?? req.resources?.disk;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.round(requested * 1024);
  }
  return DEFAULT_DISK_MIB;
}

function shellSingle(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function envAssignments(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${quoteShellArgv([v])}`)
    .join(' ');
}

function execScript(cmd: string, opts?: CloudExecOptions): string {
  const parts: string[] = ['set -e'];
  if (opts?.cwd) parts.push(`cd ${quoteShellArgv([opts.cwd])}`);
  const env = envAssignments(opts?.env);
  const user = opts?.user ?? 'vscode';
  if (user !== 'root') {
    // The env goes INSIDE the target-user shell, not the outer root one. sudo's
    // default `env_reset` drops arbitrary exported values, so exporting first
    // and dropping privileges after silently lost every per-command override.
    // Prefixing the assignments onto the inner `bash -lc` keeps them without
    // needing `-E` or an env_keep sudoers rule.
    const inner = env ? `export ${env}\n${cmd}` : cmd;
    parts.push(`exec sudo -n -u ${quoteShellArgv([user])} bash -lc ${shellSingle(inner)}`);
  } else {
    if (env) parts.push(`export ${env}`);
    parts.push(cmd);
  }
  return parts.join('\n');
}

async function waitForState(
  sandboxId: string,
  target: CloudState,
  deadlineMs: number,
): Promise<void> {
  const client = makeCreateOsClient();
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const view = await withCreateOsRetry(
      { method: 'get', retryOnAmbiguous: true, attemptTimeoutMs: 15_000 },
      (signal) => client.getSandbox(sandboxId, signal),
    );
    if (target === 'running' && view?.status === 'running') return;
    if (target === 'paused' && view?.status === 'paused') return;
    const state = mapState(view?.status);
    if (state === 'missing') throw new Error(`createos: sandbox ${sandboxId} is ${view?.status ?? 'missing'}`);
    if (Date.now() >= deadline) {
      throw new Error(`createos: timed out waiting for sandbox ${sandboxId} to become ${target}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function installRuntime(
  h: CloudHandle,
  assets: ReturnType<typeof resolveRuntimeAssets>,
  log: (line: string) => void,
): Promise<void> {
  const client = makeCreateOsClient();
  for (const asset of assets) {
    const remote = `/tmp/${asset.remoteBasename}`;
    log(`createos: upload ${asset.name} -> ${remote}`);
    await withCreateOsRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      (signal) => client.uploadFile(h.sandboxId, asset.localPath, remote, signal),
    );
    const mode = asset.remoteMode;
    if (mode !== undefined) {
      await withCreateOsRetry(
        { method: 'chmod', retryOnAmbiguous: true, attemptTimeoutMs: 30_000 },
        (signal) => client.exec(h.sandboxId, 'chmod', [mode.toString(8), remote], signal),
      );
    }
  }
  const res = await withCreateOsRetry(
    { method: 'installRuntime', retryOnAmbiguous: false, attemptTimeoutMs: 1_800_000, backoffMs: [] },
    (signal) => client.exec(h.sandboxId, 'bash', ['/tmp/agentbox-install.sh'], signal),
  );
  if ((res.result?.exit_code ?? 0) !== 0) {
    const stdout = res.result?.stdout?.trim();
    const stderr = res.result?.stderr?.trim();
    const details = [stdout, stderr].filter(Boolean).join('\n');
    throw new Error(`createos: runtime install failed: ${details}`);
  }
  if (res.result?.stdout) for (const line of res.result.stdout.split('\n')) if (line.trim()) log(line);
}

function ingressUrl(view: CreateOsSandboxView | null, port: number, sandboxId: string): string {
  const tmpl = view?.ingress_url_template;
  if (tmpl) return tmpl.replace('<port>', String(port));
  return `https://${sandboxId.replace(/^sb[_-]?/, '')}-${String(port)}.sb.createos.sh`;
}

function isLifecycleInProgress(err: unknown, words: readonly string[]): boolean {
  return err instanceof CreateOsApiError && err.statusCode === 409 && words.some((w) => err.body.includes(w));
}

/**
 * CreateOS is shaped like the SDK-only cloud providers from AgentBox's point
 * of view: no SSH, public ingress URLs, pause/resume through the provider API,
 * and workspace/runtime operations over HTTP endpoints.
 *
 * Unlike E2B, CreateOS templates/rootfs builds do not currently accept an
 * AgentBox file build context, so `agentbox prepare --provider createos` only
 * validates credentials/assets and each provision installs the runtime into
 * the fresh rootfs before the shared cloud scaffold seeds the workspace.
 */
export const createosBackend = {
  name: 'createos',
  webProxyPort: CREATEOS_WEB_PORT,
  timeoutModel: 'inactivity',

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const client = makeCreateOsClient();
    const parsed = parseCreateosSize(req.size);
    const log = req.onLog ?? (() => {});
    const sandboxName = createosSandboxName(req.name);
    if (sandboxName !== req.name) {
      log(`createos: provider name ${sandboxName} (shortened from ${req.name})`);
    }
    // Resolve local runtime assets BEFORE allocating compute: a missing staged
    // asset is the most common post-create failure and there is no reason to
    // pay for a VM to discover it.
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    const created = await withCreateOsRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 120_000, backoffMs: [] },
      (signal) =>
        client.createSandbox(
          {
            name: sandboxName,
            shape: parsed.shape,
            rootfs: rootfsFor(req),
            disk_mib: diskMibFor(req, parsed.resources?.disk),
            ingress_enabled: true,
            auto_pause_after_seconds: req.timeoutMs
              ? Math.max(60, Math.round(req.timeoutMs / 1000))
              : undefined,
            envs: { ...req.env, [OWNED_ENV_KEY]: '1' },
            egress: ['*'],
          },
          signal,
        ),
    );
    const handle: CloudHandle = {
      sandboxId: created.id,
      resources: {
        cpu: created.vcpu ?? parsed.resources?.cpu,
        memory: created.mem_mib ? created.mem_mib / 1024 : parsed.resources?.memory,
        disk: created.disk_mib ? created.disk_mib / 1024 : parsed.resources?.disk,
      },
    };
    // Everything past this point owns a billable sandbox the shared cloud
    // scaffold cannot see yet — it only receives a handle once `provision`
    // RETURNS, so its own cleanup covers the later bootstrap phase, not this
    // one. A readiness timeout or a failed install would otherwise leak the VM.
    try {
      await waitForState(handle.sandboxId, 'running', 120_000);
      await installRuntime(handle, assets, log);
    } catch (err) {
      try {
        await withCreateOsRetry(
          { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
          (signal) => makeCreateOsClient().destroySandbox(handle.sandboxId, signal),
        );
      } catch (cleanupErr) {
        // Surface the id rather than swallowing it: the user now has to delete
        // this by hand, and losing the id is the worst outcome available here.
        log(
          `createos: WARNING could not clean up sandbox ${handle.sandboxId} after a failed create ` +
            `(${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}). ` +
            `Delete it manually: createos sandbox delete ${handle.sandboxId}`,
        );
      }
      throw err;
    }
    log(`createos: created sandbox ${handle.sandboxId}`);
    return handle;
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const view = await withCreateOsRetry(
      { method: 'get', retryOnAmbiguous: true },
      (signal) => makeCreateOsClient().getSandbox(sandboxId, signal),
    );
    return view ? { sandboxId } : null;
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const items = await withCreateOsRetry(
      { method: 'list', retryOnAmbiguous: true },
      (signal) => makeCreateOsClient().listSandboxes(signal),
    );
    return items
      // Ownership, not "has a name". The old `|| s.name !== undefined` made the
      // prefix test dead code and admitted EVERY named sandbox, so `agentbox
      // prune --provider createos -y` offered the user's own unrelated CreateOS
      // sandboxes as deletion candidates. Fails closed: a box created before
      // the marker existed is simply never pruned.
      .filter((s) => s.envs?.includes(OWNED_ENV_KEY))
      .filter((s) => mapState(s.status) !== 'missing')
      .map((s) => ({
        sandboxId: s.id,
        name: s.name,
        createdAt: s.created_at,
        state: mapState(s.status),
      }));
  },

  async start(h: CloudHandle): Promise<void> {
    await this.resume(h);
  },

  async stop(h: CloudHandle): Promise<void> {
    await this.pause(h);
  },

  async pause(h: CloudHandle): Promise<void> {
    try {
      await withCreateOsRetry(
        { method: 'pause', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
        (signal) => makeCreateOsClient().pauseSandbox(h.sandboxId, signal),
      );
    } catch (err) {
      if (!isLifecycleInProgress(err, ['sandbox is pausing', 'sandbox is paused'])) throw err;
    }
    await waitForState(h.sandboxId, 'paused', 120_000);
  },

  async resume(h: CloudHandle): Promise<void> {
    try {
      await withCreateOsRetry(
        { method: 'resume', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
        (signal) => makeCreateOsClient().resumeSandbox(h.sandboxId, signal),
      );
    } catch (err) {
      if (!isLifecycleInProgress(err, ['sandbox is resuming', 'sandbox is running'])) throw err;
    }
    await waitForState(h.sandboxId, 'running', 120_000);
  },

  async destroy(h: CloudHandle): Promise<void> {
    await withCreateOsRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      (signal) => makeCreateOsClient().destroySandbox(h.sandboxId, signal),
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const view = await withCreateOsRetry(
      { method: 'state', retryOnAmbiguous: true },
      (signal) => makeCreateOsClient().getSandbox(h.sandboxId, signal),
    );
    return mapState(view?.status);
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const script = execScript(cmd, opts);
    // Never retry an ambiguous exec. A per-attempt timeout means "no response
    // yet", not "did not run": the guest command may still be live, so a second
    // attempt could replay a file mutation, a migration, or a process launch.
    // We abort the socket on timeout (see retry.ts) but cancelling HTTP proves
    // nothing about the guest — only a managed process id could, and CreateOS's
    // buffered /exec doesn't return one. Explicit 429s are still retried.
    const res = await withCreateOsRetry(
      {
        method: 'exec',
        retryOnAmbiguous: false,
        attemptTimeoutMs: opts?.attemptTimeoutMs ?? 300_000,
        backoffMs: opts?.noRetry ? [] : undefined,
      },
      (signal) => makeCreateOsClient().exec(h.sandboxId, 'bash', ['-lc', script], signal),
    );
    const result = res.result;
    return {
      exitCode: result?.exit_code ?? 0,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    };
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    await withCreateOsRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      (signal) => makeCreateOsClient().uploadFile(h.sandboxId, localPath, remotePath, signal),
    );
    await this.exec(h, `chown vscode:vscode ${quoteShellArgv([remotePath])}`, { user: 'root' }).catch(() => {});
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    await withCreateOsRetry(
      { method: 'downloadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      (signal) => makeCreateOsClient().downloadFile(h.sandboxId, remotePath, localPath, signal),
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    const script = `node -e ${shellSingle(
      "const fs=require('fs'); const dir=process.argv[1]; const out=fs.readdirSync(dir,{withFileTypes:true}).map(e=>({name:e.name,isDir:e.isDirectory()})); process.stdout.write(JSON.stringify(out));",
    )} ${quoteShellArgv([remoteDir])}`;
    const r = await this.exec(h, script);
    if (r.exitCode !== 0) throw new Error(`createos: list files failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as CloudFileEntry[];
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    const view = await withCreateOsRetry(
      { method: 'previewUrl', retryOnAmbiguous: true },
      (signal) => makeCreateOsClient().getSandbox(h.sandboxId, signal),
    );
    return { url: ingressUrl(view, port, h.sandboxId) };
  },

  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },

  async renewTimeout(h: CloudHandle, targetDeadlineEpochMs: number): Promise<void> {
    const seconds = Math.max(60, Math.round((targetDeadlineEpochMs - Date.now()) / 1000));
    await withCreateOsRetry(
      { method: 'renewTimeout', retryOnAmbiguous: true },
      (signal) =>
        makeCreateOsClient().patchSandbox(h.sandboxId, { auto_pause_after_seconds: seconds }, signal),
    );
  },
} satisfies Parameters<typeof createCloudProvider>[0];
