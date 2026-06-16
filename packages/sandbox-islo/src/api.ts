import { TokenProvider } from '@islo-labs/sdk';
import { ensureIsloEnvLoaded } from './env-loader.js';

export const DEFAULT_ISLO_CONTROL_URL = 'https://api.islo.dev';
export const DEFAULT_ISLO_COMPUTE_URL = 'https://ca.compute.islo.dev';

export class IsloApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'IsloApiError';
  }
}

export interface IsloSandboxResponse {
  created_at?: string;
  id: string;
  image?: string;
  name: string;
  status: string;
}

export interface IsloListResponse<T> {
  items: T[];
  next_cursor?: string | null;
}

export interface IsloExecResponse {
  exec_id: string;
  status: string;
}

export interface IsloExecResultResponse {
  exit_code?: number | null;
  status: string;
  stderr: string;
  stdout: string;
}

export interface IsloShareResponse {
  port: number;
  share_id: string;
  url: string;
}

export interface IsloSnapshotResponse {
  name: string;
  status: string;
}

export function resolveApiKey(): string {
  ensureIsloEnvLoaded();
  const key = process.env.AGENTBOX_ISLO_API_KEY ?? process.env.ISLO_API_KEY;
  if (!key) {
    throw new Error(
      'Islo credentials not configured.\n' +
        'Run `agentbox islo login` to paste an API key, run `islo login` and use the Islo CLI directly, ' +
        'or set ISLO_API_KEY / AGENTBOX_ISLO_API_KEY in the environment.',
    );
  }
  return key;
}

export function hasUsableCredentials(): boolean {
  ensureIsloEnvLoaded();
  return Boolean(process.env.AGENTBOX_ISLO_API_KEY ?? process.env.ISLO_API_KEY);
}

export function resolveBaseUrl(): string {
  ensureIsloEnvLoaded();
  return (process.env.AGENTBOX_ISLO_BASE_URL ?? process.env.ISLO_BASE_URL ?? DEFAULT_ISLO_COMPUTE_URL)
    .replace(/\/+$/u, '');
}

export function resolveControlUrl(): string {
  ensureIsloEnvLoaded();
  return (process.env.AGENTBOX_ISLO_CONTROL_URL ?? process.env.ISLO_CONTROL_URL ?? DEFAULT_ISLO_CONTROL_URL)
    .replace(/\/+$/u, '');
}

export function isNotFound(err: unknown): boolean {
  return err instanceof IsloApiError && err.status === 404;
}

export async function isloJson<T>(
  method: string,
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const res = await isloFetch(method, path, {
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    contentType: opts.body === undefined ? undefined : 'application/json',
    timeoutMs: opts.timeoutMs,
  });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function isloFetch(
  method: string,
  path: string,
  opts: { body?: string | Uint8Array | Buffer; contentType?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const tokenProvider = new TokenProvider({
      baseUrl: resolveControlUrl(),
      apiKey: resolveApiKey(),
    });
    const token = await tokenProvider.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (opts.contentType) headers['content-type'] = opts.contentType;
    const res = await fetch(`${resolveBaseUrl()}${path}`, {
      method,
      headers,
      body: opts.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new IsloApiError(`islo ${method} ${path}: ${String(res.status)} ${body}`, res.status, body);
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}
