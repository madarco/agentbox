import { writeFileSync } from 'node:fs';
import { abJson } from './exec.js';

export interface HubTarget {
  url: string;
  token: string;
}

export interface HubBox {
  id: string;
  name?: string;
  provider: string;
  state?: string;
  status: string;
  branch?: string;
  agent?: string;
  webUrl?: string;
  vncUrl?: string;
  hasGit?: boolean;
  pr?: { repo: string; number: number; url?: string; state: string };
  managerId?: string;
  [k: string]: unknown;
}

let cached: HubTarget | undefined;

export async function hubTarget(): Promise<HubTarget> {
  cached ??= await abJson<HubTarget>(['hub', 'target', '--json', '--local']);
  return cached;
}

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`${path} -> HTTP ${String(status)}: ${body.slice(0, 300)}`);
  }
}

export async function hubFetch(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Response> {
  const t = await hubTarget();
  const headers: Record<string, string> = {};
  const token = init.token === undefined ? t.token : init.token;
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${t.url}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function hubJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await hubFetch(path, init);
  const text = await res.text();
  if (!res.ok) throw new HubError(res.status, text, path);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function hubBoxes(): Promise<HubBox[]> {
  const r = await hubJson<{ boxes?: HubBox[] } | HubBox[]>('/api/v1/boxes');
  return Array.isArray(r) ? r : (r.boxes ?? []);
}

/**
 * A real box by name. In-flight and failed creates also appear in the list as
 * synthetic `job:<id>` rows (the tray shows them); those are not boxes.
 */
export async function hubBox(name: string): Promise<HubBox | undefined> {
  return (await hubBoxes()).find((b) => b.name === name && !b.id.startsWith('job:'));
}

/** The synthetic row a failed or in-flight create leaves behind, if any. */
export async function hubCreateJob(name: string): Promise<HubBox | undefined> {
  return (await hubBoxes()).find((b) => b.name === name && b.id.startsWith('job:'));
}

/** Save a payload next to the step log (the tray's decode tests replay these). */
export async function snapshot(path: string, apiPath: string): Promise<unknown> {
  const body = await hubJson<unknown>(apiPath);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return body;
}
