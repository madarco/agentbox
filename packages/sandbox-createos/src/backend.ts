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

const DEFAULT_SHAPE = 's-2vcpu-2gb';
const DEFAULT_ROOTFS = 'devbox:1';
const DEFAULT_DISK_MIB = 20_480;
const CREATEOS_WEB_PORT = 8080;

function mapState(status: string | undefined): CloudState {
  switch (status) {
    case 'running':
    case 'creating':
    case 'resuming':
      return 'running';
    case 'paused':
    case 'pausing':
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

function diskMibFor(req: CloudProvisionRequest, parsedDiskGb: number | undefined): number {
  const requested = req.resources?.disk ?? parsedDiskGb;
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
  if (env) parts.push(`export ${env}`);
  const user = opts?.user ?? 'vscode';
  if (user !== 'root') {
    parts.push(`exec sudo -n -u ${quoteShellArgv([user])} bash -lc ${shellSingle(cmd)}`);
  } else {
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
      () => client.getSandbox(sandboxId),
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

async function installRuntime(h: CloudHandle, log: (line: string) => void): Promise<void> {
  const client = makeCreateOsClient();
  const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
  for (const asset of assets) {
    const remote = `/tmp/${asset.remoteBasename}`;
    log(`createos: upload ${asset.name} -> ${remote}`);
    await withCreateOsRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      () => client.uploadFile(h.sandboxId, asset.localPath, remote),
    );
    const mode = asset.remoteMode;
    if (mode !== undefined) {
      await withCreateOsRetry(
        { method: 'chmod', retryOnAmbiguous: true, attemptTimeoutMs: 30_000 },
        () => client.exec(h.sandboxId, 'chmod', [mode.toString(8), remote]),
      );
    }
  }
  const res = await withCreateOsRetry(
    { method: 'installRuntime', retryOnAmbiguous: false, attemptTimeoutMs: 1_800_000, backoffMs: [] },
    () => client.exec(h.sandboxId, 'bash', ['/tmp/agentbox-install.sh']),
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
    const created = await withCreateOsRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 120_000, backoffMs: [] },
      () =>
        client.createSandbox({
          name: req.name,
          shape: parsed.shape,
          rootfs: rootfsFor(req),
          disk_mib: diskMibFor(req, parsed.resources?.disk),
          ingress_enabled: true,
          auto_pause_after_seconds: req.timeoutMs
            ? Math.max(60, Math.round(req.timeoutMs / 1000))
            : undefined,
          envs: req.env,
          egress: ['*'],
        }),
    );
    const handle: CloudHandle = {
      sandboxId: created.id,
      resources: {
        cpu: created.vcpu ?? parsed.resources?.cpu,
        memory: created.mem_mib ? created.mem_mib / 1024 : parsed.resources?.memory,
        disk: created.disk_mib ? created.disk_mib / 1024 : parsed.resources?.disk,
      },
    };
    await waitForState(handle.sandboxId, 'running', 120_000);
    await installRuntime(handle, log);
    log(`createos: created sandbox ${handle.sandboxId}`);
    return handle;
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const view = await withCreateOsRetry(
      { method: 'get', retryOnAmbiguous: true },
      () => makeCreateOsClient().getSandbox(sandboxId),
    );
    return view ? { sandboxId } : null;
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const items = await withCreateOsRetry(
      { method: 'list', retryOnAmbiguous: true },
      () => makeCreateOsClient().listSandboxes(),
    );
    return items
      .filter((s) => s.name?.startsWith('agentbox-') || s.name !== undefined)
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
        () => makeCreateOsClient().pauseSandbox(h.sandboxId),
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
        () => makeCreateOsClient().resumeSandbox(h.sandboxId),
      );
    } catch (err) {
      if (!isLifecycleInProgress(err, ['sandbox is resuming', 'sandbox is running'])) throw err;
    }
    await waitForState(h.sandboxId, 'running', 120_000);
  },

  async destroy(h: CloudHandle): Promise<void> {
    await withCreateOsRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      () => makeCreateOsClient().destroySandbox(h.sandboxId),
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const view = await withCreateOsRetry(
      { method: 'state', retryOnAmbiguous: true },
      () => makeCreateOsClient().getSandbox(h.sandboxId),
    );
    return mapState(view?.status);
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const script = execScript(cmd, opts);
    const res = await withCreateOsRetry(
      {
        method: 'exec',
        retryOnAmbiguous: opts?.noRetry ? false : true,
        attemptTimeoutMs: opts?.attemptTimeoutMs ?? 300_000,
        backoffMs: opts?.noRetry ? [] : undefined,
      },
      () => makeCreateOsClient().exec(h.sandboxId, 'bash', ['-lc', script]),
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
      () => makeCreateOsClient().uploadFile(h.sandboxId, localPath, remotePath),
    );
    await this.exec(h, `chown vscode:vscode ${quoteShellArgv([remotePath])}`, { user: 'root' }).catch(() => {});
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    await withCreateOsRetry(
      { method: 'downloadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      () => makeCreateOsClient().downloadFile(h.sandboxId, remotePath, localPath),
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
      () => makeCreateOsClient().getSandbox(h.sandboxId),
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
      () => makeCreateOsClient().patchSandbox(h.sandboxId, { auto_pause_after_seconds: seconds }),
    );
  },
} satisfies Parameters<typeof createCloudProvider>[0];
