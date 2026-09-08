import { readFile, writeFile } from 'node:fs/promises';
import { ensureCreateOsEnvLoaded } from './env-loader.js';

export const DEFAULT_CREATEOS_ENDPOINT = 'https://api.sb.createos.sh';

/**
 * The sandbox API base URL, matching the CreateOS CLI's own
 * `--sandbox-api-url` / `$CREATEOS_SANDBOX_URL`. Exported so `build-attach`
 * hands the CLI the same endpoint the provider provisioned against — otherwise
 * `create` targets a private control plane and `attach` looks for the resulting
 * sandbox id on the CLI's default one.
 */
export function resolveCreateOsSandboxEndpoint(): string {
  ensureCreateOsEnvLoaded();
  const fromEnv = process.env.CREATEOS_SANDBOX_URL?.trim();
  return fromEnv ? fromEnv : DEFAULT_CREATEOS_ENDPOINT;
}

interface JSendSuccess<T> {
  status: 'success';
  data: T;
}

interface JSendFail {
  status: 'fail';
  data?: unknown;
}

interface JSendError {
  status: 'error';
  message?: string;
  code?: number;
}

type JSend<T> = JSendSuccess<T> | JSendFail | JSendError;

export interface CreateOsCreateSandboxRequest {
  name: string;
  shape: string;
  rootfs?: string;
  disk_mib?: number;
  ingress_enabled?: boolean;
  auto_pause_after_seconds?: number;
  envs?: Record<string, string>;
  egress?: string[];
}

export interface CreateOsSandboxView {
  id: string;
  name?: string;
  status: string;
  ip?: string;
  vcpu?: number;
  mem_mib?: number;
  disk_mib?: number;
  created_at?: string;
  shape?: string;
  rootfs?: string;
  ingress_enabled?: boolean;
  ingress_url_template?: string;
  /**
   * KEYS only of the sandbox's persistent env map — the API never returns
   * values. That makes it a usable ownership marker: we stamp
   * `AGENTBOX_OWNED` at create and read it back here (see `OWNED_ENV_KEY`).
   */
  envs?: string[];
}

export interface CreateOsCreateSandboxResponse {
  id: string;
  name?: string;
  ip?: string;
  shape?: string;
  rootfs?: string;
  vcpu?: number;
  mem_mib?: number;
  disk_mib?: number;
  ingress_url_template?: string;
}

export interface CreateOsExecResponse {
  result?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
  };
}

interface Paged<T> {
  data: T[];
  pagination?: {
    total: number;
    limit: number;
    offset: number;
    count: number;
  };
}

export class CreateOsApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`createos API ${String(statusCode)}: ${body}`);
  }
}

export class CreateOsClient {
  readonly endpoint: string;
  readonly token: string;

  constructor(opts: { endpoint?: string; token?: string } = {}) {
    ensureCreateOsEnvLoaded();
    // `CREATEOS_SANDBOX_URL`, not `CREATEOS_API_URL`: the CreateOS CLI already
    // uses those two names for DIFFERENT services — `CREATEOS_API_URL` is the
    // project/plan API (api-createos.nodeops.network), `CREATEOS_SANDBOX_URL`
    // is the sandbox API we speak here. Reading the former silently pointed
    // every sandbox call at the project API for anyone who had it exported for
    // normal CLI use. Same name, same meaning, both directions.
    this.endpoint = (opts.endpoint ?? resolveCreateOsSandboxEndpoint()).replace(/\/+$/, '');
    this.token = opts.token ?? process.env.CREATEOS_API_KEY ?? '';
    if (!this.token) {
      throw new Error(
        'CreateOS credentials not configured. Run `agentbox createos login` or set CREATEOS_API_KEY.',
      );
    }
  }

  async whoami(signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>('GET', '/v1/whoami', undefined, signal);
  }

  async createSandbox(
    req: CreateOsCreateSandboxRequest,
    signal?: AbortSignal,
  ): Promise<CreateOsCreateSandboxResponse> {
    return this.request<CreateOsCreateSandboxResponse>('POST', '/v1/sandboxes', req, signal);
  }

  async listSandboxes(signal?: AbortSignal): Promise<CreateOsSandboxView[]> {
    const all: CreateOsSandboxView[] = [];
    let offset = 0;
    const limit = 500;
    for (;;) {
      const page = await this.request<Paged<CreateOsSandboxView>>(
        'GET',
        `/v1/sandboxes?limit=${String(limit)}&offset=${String(offset)}`,
        undefined,
        signal,
      );
      all.push(...page.data);
      const count = page.pagination?.count ?? page.data.length;
      const total = page.pagination?.total ?? all.length;
      if (count <= 0 || all.length >= total) break;
      offset += count;
    }
    return all;
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<CreateOsSandboxView | null> {
    try {
      return await this.request<CreateOsSandboxView>(
        'GET',
        `/v1/sandboxes/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    } catch (err) {
      if (err instanceof CreateOsApiError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async patchSandbox(
    id: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CreateOsSandboxView> {
    return this.request<CreateOsSandboxView>(
      'PATCH',
      `/v1/sandboxes/${encodeURIComponent(id)}`,
      body,
      signal,
    );
  }

  async pauseSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(id)}/pause`,
      undefined,
      signal,
    );
  }

  async resumeSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(id)}/resume`,
      undefined,
      signal,
    );
  }

  async destroySandbox(id: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.request<unknown>(
        'DELETE',
        `/v1/sandboxes/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    } catch (err) {
      if (err instanceof CreateOsApiError && err.statusCode === 404) return;
      throw err;
    }
  }

  async exec(
    id: string,
    cmd: string,
    args: string[] = [],
    signal?: AbortSignal,
  ): Promise<CreateOsExecResponse> {
    return this.request<CreateOsExecResponse>(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(id)}/exec`,
      { cmd, args },
      signal,
    );
  }

  async uploadFile(
    id: string,
    localPath: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = await readFile(localPath);
    await this.raw(
      'PUT',
      `/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(remotePath)}`,
      body,
      'application/octet-stream',
      signal,
    );
  }

  async downloadFile(
    id: string,
    remotePath: string,
    localPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.raw(
      'GET',
      `/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(remotePath)}`,
      undefined,
      undefined,
      signal,
    );
    await writeFile(localPath, Buffer.from(await res.arrayBuffer()));
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.raw(
      method,
      path,
      body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
      body === undefined ? undefined : 'application/json',
      signal,
    );
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as JSend<T>) : ({ status: 'success', data: undefined } as JSend<T>);
    if (parsed.status === 'success') return parsed.data;
    if (parsed.status === 'error') {
      throw new CreateOsApiError(res.status, parsed.message ?? text);
    }
    throw new CreateOsApiError(res.status, JSON.stringify(parsed.data ?? parsed));
  }

  private async raw(
    method: string,
    path: string,
    body?: Buffer,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'X-Api-Key': this.token,
      'User-Agent': 'agentbox-createos-provider',
    };
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(`${this.endpoint}${path}`, { method, headers, body, signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new CreateOsApiError(res.status, text);
    }
    return res;
  }
}

export function makeCreateOsClient(): CreateOsClient {
  return new CreateOsClient();
}
