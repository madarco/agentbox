/**
 * Client for a hub's custody surface. Pushes agent credentials, project secrets,
 * and box SSH material up to the hub, and pulls them back down. Uploads are
 * hash-skipped: the client fetches the manifest first and only PUTs a value whose
 * local sha256 differs from what custody already holds, so an unchanged
 * `credentials push` sends zero bytes.
 *
 * It speaks EITHER of two surfaces, chosen by which credential the caller has —
 * so a custody op works with whichever one is available, and never silently
 * no-ops for lack of the "wrong" one:
 *
 *   - **`/api/v1/custody`** (preferred) when an **API key** is present — the public
 *     client surface the tray/web also use. list/put/delete authorize with the API
 *     key (Bearer); a byte-read GET additionally presents the ADMIN token as
 *     `X-Agentbox-Admin-Token`, and a control box refuses a byte-read carrying only
 *     the API key — the two-tier contract (values never leave the box to a thin
 *     client). A plain local hub needs no admin token (its hub token gates the
 *     whole surface).
 *   - **`/admin/custody`** (fallback) when only the **admin token** is present (no
 *     API key). The admin bearer authorizes every verb incl. the byte-read, so a
 *     machine that ran `hub setup` but has no API key (e.g. a via-hub create host)
 *     can still pull per-box SSH keys instead of skipping them. This is the internal
 *     relay wire; it stays until the API key is guaranteed everywhere (Step 11).
 *
 * The constructor throws if NEITHER credential is present — a custody op must fail
 * loudly at the source, never resolve to a quiet no-op that breaks later.
 */

import { createHash } from 'node:crypto';
import {
  AGENT_SYNC_SPECS,
  isRealAgentCredential,
  readCredentialBackup,
  type AgentId,
} from '@agentbox/sandbox-core';
import { HubApiError } from './hub-api-client.js';

export interface CustodyEntry {
  path: string;
  size: number;
  sha256: string;
  mode: number;
  updatedAt: string;
}

export interface CustodyClientOptions {
  /** Base hub URL (no trailing slash needed). */
  url: string;
  /**
   * Hub API key — `AGENTBOX_HUB_API_KEY` for a control box, or the local hub token.
   * Present → the `/api/v1/custody` surface. Absent → the admin fallback (needs
   * `adminToken`).
   */
  apiKey?: string;
  /**
   * Admin token (`AGENTBOX_RELAY_ADMIN_TOKEN`). On `/api/v1` it is the elevated
   * credential a byte-read needs on a control box; when no API key is present it is
   * the sole credential for the `/admin/custody` fallback.
   */
  adminToken?: string;
  fetchImpl?: typeof fetch;
}

/** Hex sha256 — matches the store's `custodyDigest` so the skip check agrees byte-for-byte. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export class CustodyClient {
  private readonly base: string;
  private readonly apiKey: string | undefined;
  private readonly adminToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  /** True → `/api/v1/custody`; false → the `/admin/custody` admin fallback. */
  private readonly useApi: boolean;

  constructor(opts: CustodyClientOptions) {
    if (!opts.apiKey && !opts.adminToken) {
      // Fail loudly at construction: a custody client with no credential could only
      // ever produce quiet no-ops / confusing 401s far from here.
      throw new Error(
        'CustodyClient needs a hub API key or an admin token (set AGENTBOX_HUB_API_KEY, or run from the machine that ran `agentbox hub setup`).',
      );
    }
    this.base = opts.url.replace(/\/+$/, '');
    this.apiKey = opts.apiKey || undefined;
    this.adminToken = opts.adminToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.useApi = Boolean(this.apiKey);
  }

  /** The base path of the chosen surface (`/api/v1/custody` or `/admin/custody`). */
  private prefix(): string {
    return this.useApi ? `${this.base}/api/v1/custody` : `${this.base}/admin/custody`;
  }

  /** Bearer for the chosen surface: API key on `/api/v1`, admin token on `/admin`. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const bearer = this.useApi ? this.apiKey! : this.adminToken!;
    return { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...extra };
  }

  private encodePath(path: string): string {
    return path
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
  }

  /** Turn a non-2xx response into a `HubApiError`, handling both surfaces' error shapes. */
  private async errorFrom(res: Response, fallback: string): Promise<HubApiError> {
    let code = 'internal';
    let message = fallback;
    try {
      // `/api/v1` → { error: { code, message } }; `/admin` → { error: "<string>" }.
      const body = (await res.json()) as { error?: { code?: string; message?: string } | string };
      if (typeof body.error === 'string') {
        message = body.error;
      } else if (body.error) {
        if (body.error.code) code = body.error.code;
        if (body.error.message) message = body.error.message;
      }
    } catch {
      message = `${fallback}: ${res.status} ${await safeText(res)}`;
    }
    return new HubApiError(message, code, res.status);
  }

  /** The manifest (paths + hashes, never values), optionally scoped to a prefix. */
  async list(prefix?: string): Promise<CustodyEntry[]> {
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    const res = await this.fetchImpl(`${this.prefix()}${q}`, { headers: this.headers() });
    if (!res.ok) throw await this.errorFrom(res, 'custody list failed');
    // The `/api/v1` list route reports `enabled: false` on a hub with no custody
    // store; treat that as an empty manifest so a push/pull degrades cleanly.
    return ((await res.json()) as { enabled?: boolean; entries: CustodyEntry[] }).entries ?? [];
  }

  /** Upload bytes; returns whether custody actually changed (metadata only, no bytes). */
  async put(path: string, data: Buffer): Promise<{ changed: boolean; sha256: string }> {
    const res = await this.fetchImpl(`${this.prefix()}/${this.encodePath(path)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ data: data.toString('base64') }),
    });
    if (!res.ok) throw await this.errorFrom(res, `custody put ${path} failed`);
    const body = (await res.json()) as { changed: boolean; sha256: string };
    return { changed: body.changed, sha256: body.sha256 };
  }

  /**
   * Download bytes, or null when the entry is absent (404). On `/api/v1` it presents
   * the admin token so a control box authorizes the byte-read; without it a control
   * box answers 401 and this throws (a thin client can't read a stored value). On
   * the `/admin` fallback the admin bearer already authorizes the read.
   */
  async get(path: string): Promise<Buffer | null> {
    const extra: Record<string, string> =
      this.useApi && this.adminToken ? { 'X-Agentbox-Admin-Token': this.adminToken } : {};
    const res = await this.fetchImpl(`${this.prefix()}/${this.encodePath(path)}`, {
      headers: this.headers(extra),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.errorFrom(res, `custody get ${path} failed`);
    const body = (await res.json()) as { data: string };
    return Buffer.from(body.data, 'base64');
  }

  /** Delete one custody entry. Returns whether it existed (false on 404). */
  async delete(path: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.prefix()}/${this.encodePath(path)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.status === 404) return false;
    if (res.status === 204 || res.ok) return true;
    throw await this.errorFrom(res, `custody delete ${path} failed`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/** One item to consider uploading: its custody path and the local bytes. */
export interface UploadItem {
  path: string;
  data: Buffer;
}

export interface PushDecision {
  path: string;
  action: 'upload' | 'skip';
  reason: string;
}

/**
 * Decide, per item, whether to upload — pure so it is unit-testable without a
 * server. An item is skipped only when custody already holds the exact bytes
 * (sha256 match); `force` uploads regardless. Never compares timestamps.
 */
export function planPush(
  items: UploadItem[],
  manifest: CustodyEntry[],
  opts: { force?: boolean } = {},
): PushDecision[] {
  const byPath = new Map(manifest.map((e) => [e.path, e]));
  return items.map((item) => {
    if (opts.force) return { path: item.path, action: 'upload', reason: 'forced' };
    const existing = byPath.get(item.path);
    if (existing && existing.sha256 === sha256Hex(item.data)) {
      return { path: item.path, action: 'skip', reason: 'hash match' };
    }
    return { path: item.path, action: 'upload', reason: existing ? 'changed' : 'new' };
  });
}

/**
 * Gather the agent-credential upload set from the host backups, driven by the
 * SAME registry a cloud create seeds from (`AGENT_SYNC_SPECS`) — no second file
 * list. Each real backup is stored under `agents/<id>/<credential.boxRelPath>`
 * (the box-canonical name), and only real (non-placeholder) blobs are included.
 */
export async function collectAgentCredentialUploads(only?: AgentId): Promise<UploadItem[]> {
  const items: UploadItem[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    if (only && spec.id !== only) continue;
    const text = await readCredentialBackup(spec.id);
    if (text === null || !isRealAgentCredential(spec.id, text)) continue;
    items.push({
      path: `agents/${spec.id}/${spec.credential.boxRelPath}`,
      data: Buffer.from(text, 'utf8'),
    });
  }
  return items;
}
