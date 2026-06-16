import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@agentbox/core';
import {
  isloJson,
  isNotFound,
  type IsloExecResponse,
  type IsloExecResultResponse,
  type IsloListResponse,
  type IsloSandboxResponse,
  type IsloShareResponse,
  type IsloSnapshotResponse,
} from './api.js';

export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';
export const DEFAULT_ISLO_IMAGE_REF = 'ghcr.io/madarco/agentbox/box:latest';

const BOX_USER = 'vscode';
const POLL_INTERVAL_MS = 1_000;
const UPLOAD_CHUNK_CHARS = 48_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function safeSandboxName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `agentbox-${cleaned || 'box'}-${Date.now().toString(36)}`;
}

function imageFor(req: CloudProvisionRequest): string {
  return !req.image || req.image === DEFAULT_BOX_IMAGE_REF ? DEFAULT_ISLO_IMAGE_REF : req.image;
}

function mapState(status: string | undefined): CloudState {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
    case 'starting':
      return 'running';
    case 'paused':
      return 'paused';
    case 'stopped':
    case 'stopping':
      return 'stopped';
    case 'deleted':
    case 'failed':
    default:
      return 'missing';
  }
}

function parseSize(size: string | undefined): { cpu?: number; memory?: number; disk?: number } {
  if (!size) return {};
  const m = /^(\d+(?:\.\d+)?)-(\d+)-(\d+)$/u.exec(size.trim());
  if (!m) return {};
  return { cpu: Number(m[1]), memory: Number(m[2]), disk: Number(m[3]) };
}

function isTerminalExecStatus(status: string): boolean {
  return ['completed', 'succeeded', 'success', 'failed', 'error', 'cancelled', 'canceled'].includes(
    status.toLowerCase(),
  );
}

async function waitForExecResult(
  sandboxName: string,
  execId: string,
  timeoutMs: number,
): Promise<IsloExecResultResponse> {
  const started = Date.now();
  let last: IsloExecResultResponse | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await isloJson<IsloExecResultResponse>(
      'GET',
      `/sandboxes/${encodeURIComponent(sandboxName)}/exec/${encodeURIComponent(execId)}`,
      { timeoutMs: 30_000 },
    );
    if (last.exit_code !== undefined && last.exit_code !== null) return last;
    if (isTerminalExecStatus(last.status)) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `islo exec ${execId} timed out after ${String(timeoutMs)}ms` +
      (last ? ` (last status: ${last.status})` : ''),
  );
}

export const isloBackend: CloudBackend = {
  name: 'islo',

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const size = parseSize(req.size);
    const resources = {
      cpu: req.resources?.cpu ?? size.cpu,
      memory: req.resources?.memory ?? size.memory,
      disk: req.resources?.disk ?? size.disk,
    };
    const body: Record<string, unknown> = {
      name: safeSandboxName(req.name),
      image: imageFor(req),
      workdir: '/workspace',
      env: req.env,
    };
    if (req.snapshot) body.snapshot_name = req.snapshot;
    if (resources.cpu && resources.cpu > 0) body.vcpus = resources.cpu;
    if (resources.memory && resources.memory > 0) body.memory_mb = resources.memory * 1024;
    if (resources.disk && resources.disk > 0) body.disk_gb = resources.disk;
    if (req.networkPolicy) body.gateway_profile = req.networkPolicy;

    const sb = await isloJson<IsloSandboxResponse>('POST', '/sandboxes', {
      body,
      timeoutMs: 300_000,
    });
    req.onLog?.(`islo: created sandbox ${sb.name} (${sb.id}) from ${String(body.image)}`);
    return { sandboxId: sb.name };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    try {
      await isloJson<IsloSandboxResponse>('GET', `/sandboxes/${encodeURIComponent(sandboxId)}`);
      return { sandboxId };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async list(): Promise<CloudSandboxSummary[]> {
    const summaries: CloudSandboxSummary[] = [];
    let cursor: string | null | undefined;
    do {
      const qs = new URLSearchParams({ name_prefix: 'agentbox-', limit: '100' });
      if (cursor) qs.set('cursor', cursor);
      const page = await isloJson<IsloListResponse<IsloSandboxResponse>>(
        'GET',
        `/sandboxes?${qs.toString()}`,
      );
      for (const item of page.items ?? []) {
        summaries.push({
          sandboxId: item.name,
          name: item.name,
          createdAt: item.created_at,
          state: mapState(item.status),
        });
      }
      cursor = page.next_cursor;
    } while (cursor);
    return summaries;
  },

  async start(h: CloudHandle): Promise<void> {
    try {
      await this.resume(h);
    } catch (err) {
      // A running sandbox can conflict on resume; exec will still work.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/409|conflict/i.test(msg)) throw err;
    }
  },

  async stop(h: CloudHandle): Promise<void> {
    await this.pause(h);
  },

  async pause(h: CloudHandle): Promise<void> {
    await isloJson<IsloSandboxResponse>(
      'POST',
      `/sandboxes/${encodeURIComponent(h.sandboxId)}/pause`,
      { timeoutMs: 180_000 },
    );
  },

  async resume(h: CloudHandle): Promise<void> {
    await isloJson<IsloSandboxResponse>(
      'POST',
      `/sandboxes/${encodeURIComponent(h.sandboxId)}/resume`,
      { timeoutMs: 180_000 },
    );
  },

  async destroy(h: CloudHandle): Promise<void> {
    try {
      await isloJson<void>('DELETE', `/sandboxes/${encodeURIComponent(h.sandboxId)}`, {
        timeoutMs: 180_000,
      });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async state(h: CloudHandle): Promise<CloudState> {
    try {
      const sb = await isloJson<IsloSandboxResponse>(
        'GET',
        `/sandboxes/${encodeURIComponent(h.sandboxId)}`,
      );
      return mapState(sb.status);
    } catch (err) {
      if (isNotFound(err)) return 'missing';
      throw err;
    }
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const timeoutMs = opts?.attemptTimeoutMs ?? 120_000;
    const body = {
      command: ['bash', '-lc', cmd],
      env: opts?.env,
      timeout_secs: Math.max(1, Math.ceil(timeoutMs / 1000)),
      user: opts?.user ?? BOX_USER,
      workdir: opts?.cwd,
    };
    const started = await isloJson<IsloExecResponse>(
      'POST',
      `/sandboxes/${encodeURIComponent(h.sandboxId)}/exec`,
      { body, timeoutMs: 60_000 },
    );
    const result = await waitForExecResult(h.sandboxId, started.exec_id, timeoutMs);
    return {
      exitCode: result.exit_code ?? (result.status.toLowerCase() === 'failed' ? 1 : 0),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    const data = await readFile(localPath);
    const b64 = data.toString('base64');
    await this.exec(
      h,
      `mkdir -p ${shq(dirname(remotePath))} && : > ${shq(remotePath)} && chown ${BOX_USER}:${BOX_USER} ${shq(remotePath)} 2>/dev/null || true`,
      { user: 'root', attemptTimeoutMs: 60_000, noRetry: true },
    );
    for (let i = 0; i < b64.length; i += UPLOAD_CHUNK_CHARS) {
      const chunk = b64.slice(i, i + UPLOAD_CHUNK_CHARS);
      const r = await this.exec(
        h,
        `printf %s ${shq(chunk)} | base64 -d >> ${shq(remotePath)}`,
        { user: 'root', attemptTimeoutMs: 60_000, noRetry: true },
      );
      if (r.exitCode !== 0) {
        throw new Error(`islo uploadFile failed for ${remotePath}: ${r.stderr || r.stdout}`);
      }
    }
    await this.exec(h, `chown ${BOX_USER}:${BOX_USER} ${shq(remotePath)} 2>/dev/null || true`, {
      user: 'root',
      attemptTimeoutMs: 30_000,
      noRetry: true,
    });
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    const r = await this.exec(h, `base64 < ${shq(remotePath)}`, {
      user: 'root',
      attemptTimeoutMs: 120_000,
      noRetry: true,
    });
    if (r.exitCode !== 0) {
      throw new Error(`islo downloadFile failed for ${remotePath}: ${r.stderr || r.stdout}`);
    }
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64'));
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    const script = [
      'python3 - <<\'PY\'',
      'import json, os, pathlib',
      `p = pathlib.Path(${JSON.stringify(remoteDir)})`,
      'out = []',
      'for e in os.scandir(p):',
      '    out.append({"name": e.name, "isDir": e.is_dir(follow_symlinks=False)})',
      'print(json.dumps(out))',
      'PY',
    ].join('\n');
    const r = await this.exec(h, script, { user: 'root', attemptTimeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      throw new Error(`islo listFiles failed for ${remoteDir}: ${r.stderr || r.stdout}`);
    }
    return JSON.parse(r.stdout) as CloudFileEntry[];
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    const existing = await isloJson<IsloShareResponse[]>(
      'GET',
      `/sandboxes/${encodeURIComponent(h.sandboxId)}/shares`,
    );
    const share = existing.find((s) => s.port === port);
    if (share) return { url: share.url };
    const created = await isloJson<IsloShareResponse>(
      'POST',
      `/sandboxes/${encodeURIComponent(h.sandboxId)}/shares`,
      { body: { port, ttl_seconds: 24 * 60 * 60 } },
    );
    return { url: created.url };
  },

  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },

  async attachArgv(h: CloudHandle): Promise<string[]> {
    return ['ssh', `islo@${h.sandboxId}.islo`];
  },

  async createSnapshot(h: CloudHandle, snapshotName: string): Promise<void> {
    await isloJson<IsloSnapshotResponse>('POST', '/snapshots/', {
      body: { sandbox_name: h.sandboxId, name: snapshotName },
      timeoutMs: 600_000,
    });
  },

  async deleteSnapshot(snapshotName: string): Promise<void> {
    try {
      await isloJson<void>('DELETE', `/snapshots/${encodeURIComponent(snapshotName)}`);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async snapshotExists(snapshotName: string): Promise<boolean> {
    try {
      const snap = await isloJson<IsloSnapshotResponse>(
        'GET',
        `/snapshots/${encodeURIComponent(snapshotName)}`,
      );
      return ['ready', 'created', 'completed'].includes(snap.status.toLowerCase());
    } catch (err) {
      if (isNotFound(err)) return false;
      return false;
    }
  },
};
