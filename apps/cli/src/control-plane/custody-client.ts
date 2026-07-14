/**
 * Client for the control box's custody surface (`/admin/custody/*`). Pushes
 * agent credentials, project secrets, and box SSH material up to the always-on
 * hub, and pulls them back down. Uploads are hash-skipped: the client fetches
 * the manifest first and only PUTs a value whose local sha256 differs from what
 * custody already holds, so an unchanged `credentials push` sends zero bytes.
 */

import { createHash } from 'node:crypto';
import {
  AGENT_SYNC_SPECS,
  isRealAgentCredential,
  readCredentialBackup,
  type AgentId,
} from '@agentbox/sandbox-core';

export interface CustodyEntry {
  path: string;
  size: number;
  sha256: string;
  mode: number;
  updatedAt: string;
}

export interface CustodyClientOptions {
  /** Base control-plane URL (no trailing slash needed). */
  url: string;
  /** Admin bearer (`AGENTBOX_RELAY_ADMIN_TOKEN` or the setup-written env). */
  adminToken: string;
  fetchImpl?: typeof fetch;
}

/** Hex sha256 — matches the store's `custodyDigest` so the skip check agrees byte-for-byte. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export class CustodyClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CustodyClientOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.token = opts.adminToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  /** The manifest (paths + hashes, never values), optionally scoped to a prefix. */
  async list(prefix?: string): Promise<CustodyEntry[]> {
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    const res = await this.fetchImpl(`${this.base}/admin/custody${q}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`custody list failed: ${res.status} ${await safeText(res)}`);
    return ((await res.json()) as { entries: CustodyEntry[] }).entries;
  }

  /** Upload bytes; returns whether custody actually changed. */
  async put(path: string, data: Buffer): Promise<{ changed: boolean; sha256: string }> {
    const res = await this.fetchImpl(`${this.base}/admin/custody/${encodePath(path)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ data: data.toString('base64') }),
    });
    if (!res.ok) throw new Error(`custody put ${path} failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { changed: boolean; sha256: string };
    return { changed: body.changed, sha256: body.sha256 };
  }

  /** Download bytes, or null when the entry is absent (404). */
  async get(path: string): Promise<Buffer | null> {
    const res = await this.fetchImpl(`${this.base}/admin/custody/${encodePath(path)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`custody get ${path} failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { data: string };
    return Buffer.from(body.data, 'base64');
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
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
export async function collectAgentCredentialUploads(
  only?: AgentId,
): Promise<UploadItem[]> {
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
