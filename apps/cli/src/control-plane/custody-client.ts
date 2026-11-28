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
import { getMachineId } from '@agentbox/config';
import { accountCustodyPath, isDefaultAccount } from '@agentbox/core';
import {
  AGENT_SYNC_SPECS,
  credentialExpiry,
  isRealAgentCredential,
  readAccounts,
  readAccountSecret,
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

/**
 * At or above this a custody PUT takes the streaming blob surface. Well below
 * the JSON cap on purpose — base64 costs 4/3 on the wire and several times the
 * payload in peak memory on both ends.
 */
const BLOB_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Largest payload the base64 JSON API can carry within the relay's default
 * 32 MiB custody body cap (4/3 inflation plus envelope headroom). Only used to
 * decide whether a fallback to JSON is worth attempting against an older hub.
 */
const MAX_JSON_PAYLOAD_BYTES = Math.floor(32 * 1024 * 1024 * 0.7);

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

  /**
   * Upload bytes; returns whether custody actually changed (metadata only, no
   * bytes).
   *
   * Anything sizeable takes the streaming blob surface. The JSON API sends
   * base64 inside an envelope, so its usable ceiling is only ~0.7x its body cap
   * — `hub project push` gating on the (much larger) blob cap while uploading
   * through JSON would offer a seed the wire then refuses, which is exactly the
   * gate/transport mismatch this pair of APIs exists to end.
   */
  async put(path: string, data: Buffer): Promise<{ changed: boolean; sha256: string }> {
    if (data.length >= BLOB_THRESHOLD_BYTES) return this.putBlob(path, data);
    const res = await this.fetchImpl(`${this.prefix()}/${this.encodePath(path)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ data: data.toString('base64') }),
    });
    if (!res.ok) throw await this.errorFrom(res, `custody put ${path} failed`);
    const body = (await res.json()) as { changed: boolean; sha256: string };
    return { changed: body.changed, sha256: body.sha256 };
  }

  /** Raw octet-stream PUT, falling back to JSON on a hub that predates the route. */
  private async putBlob(path: string, data: Buffer): Promise<{ changed: boolean; sha256: string }> {
    const res = await this.fetchImpl(`${this.blobPrefix()}/${this.encodePath(path)}`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
    if (res.ok) {
      const body = (await res.json()) as { changed: boolean; sha256: string };
      return { changed: body.changed, sha256: body.sha256 };
    }
    if (res.status === 404) {
      // Older hub: no blob surface. Retry over JSON when it can plausibly fit,
      // else say why rather than let it fail as an opaque size error.
      if (data.length <= MAX_JSON_PAYLOAD_BYTES) {
        const legacy = await this.fetchImpl(`${this.prefix()}/${this.encodePath(path)}`, {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify({ data: data.toString('base64') }),
        });
        if (!legacy.ok) throw await this.errorFrom(legacy, `custody put ${path} failed`);
        const body = (await legacy.json()) as { changed: boolean; sha256: string };
        return { changed: body.changed, sha256: body.sha256 };
      }
      throw new HubApiError(
        `custody put ${path}: this hub has no streaming blob API and the payload is too large for the JSON one — run \`agentbox hub update\``,
        'not_found',
        404,
      );
    }
    throw await this.errorFrom(res, `custody put ${path} failed`);
  }

  /** Base path of the streaming blob surface, mirroring {@link prefix}. */
  private blobPrefix(): string {
    return this.useApi ? `${this.base}/api/v1/custody/blob` : `${this.base}/admin/custody-blob`;
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
 * Whether this PC's copy of a login should replace the one custody holds —
 * keep the NEWEST, not this PC's. A hub box that refreshed the login revoked
 * the PC's older copy; pushing it back would start every new hub box logged
 * out. Compared by when the access token expires (a refresh moves it forward):
 *
 * - both known: upload only when the PC's is strictly later (so an expired PC
 *   copy never replaces a live custody one);
 * - either unknown: the old last-writer-wins upload.
 */
export function credentialPushVerdict(
  agent: string,
  local: string,
  remote: string,
  now: number = Date.now(),
): { upload: boolean; reason: string } {
  const expiry = (text: string): number | null => {
    try {
      return credentialExpiry(agent as AgentId, text);
    } catch {
      return null;
    }
  };
  const mine = expiry(local);
  const theirs = expiry(remote);
  // Unknown on either side (a switch to an API-key login has no expiry): not
  // two copies of one login to order, so the old last-writer-wins upload.
  if (mine === null || theirs === null) return { upload: true, reason: 'changed' };
  if (mine <= theirs) {
    return {
      upload: false,
      reason: mine <= now ? 'this copy has expired' : 'custody copy is newer',
    };
  }
  return { upload: true, reason: 'newer login' };
}

/**
 * {@link planPush} for agent credentials: a `changed` item is uploaded only when
 * it is newer than custody's copy ({@link credentialPushVerdict}). `force` still
 * uploads everything. `agents/<agent>/...` names the agent, for every account.
 */
export async function planCredentialPush(
  items: UploadItem[],
  manifest: CustodyEntry[],
  getRemote: (path: string) => Promise<Buffer | null>,
  opts: { force?: boolean; now?: number } = {},
): Promise<PushDecision[]> {
  const plan = planPush(items, manifest, opts);
  if (opts.force) return plan;
  return Promise.all(
    plan.map(async (d, i): Promise<PushDecision> => {
      if (d.action !== 'upload' || d.reason !== 'changed') return d;
      // A PC holding only the hub API key may push but not read custody (401):
      // with nothing to compare, keep the old always-upload.
      const remote = await getRemote(d.path).catch(() => null);
      if (remote === null) return d;
      const agent = d.path.split('/')[1] ?? '';
      const v = credentialPushVerdict(
        agent,
        items[i]!.data.toString('utf8'),
        remote.toString('utf8'),
        opts.now,
      );
      return { path: d.path, action: v.upload ? 'upload' : 'skip', reason: v.reason };
    }),
  );
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
    // No declared credential -> no host backup to collect.
    if (!spec.credential) continue;
    const text = await readCredentialBackup(spec.id);
    if (text === null || !isRealAgentCredential(spec.id, text)) continue;
    items.push({
      path: `agents/${spec.id}/${spec.credential.boxRelPath}`,
      data: Buffer.from(text, 'utf8'),
    });
  }
  // Every named LOGIN too, keyed by THIS machine (account ids are local to a
  // machine: two PCs' `claude/work` can be two subscriptions). Pasted secrets
  // (API keys, setup tokens) do not travel: nothing on a hub reads them, and
  // they never refresh (Phase 5 custody design).
  // Read lazily (#444 (f)): a machine-id failure skips the named logins, never
  // the default login above. (This is the fallback for a hub without the
  // import route; a current hub takes `credential-import.ts`.)
  let machine: string | null | undefined;
  for (const account of (await readAccounts()).accounts) {
    if (isDefaultAccount(account.id) || account.kind !== 'login') continue;
    if (machine === undefined) {
      try {
        machine = getMachineId();
      } catch {
        machine = null;
      }
    }
    if (machine === null) break;
    if (only && account.agent !== only) continue;
    const spec = AGENT_SYNC_SPECS.find((s) => s.id === account.agent);
    if (!spec?.credential) continue;
    const text = await readAccountSecret(account.agent, account.id);
    if (text === null || !isRealAgentCredential(spec.id, text)) continue;
    items.push({
      path: accountCustodyPath(spec.id, account.id, spec.credential.boxRelPath, machine),
      data: Buffer.from(text, 'utf8'),
    });
  }
  return items;
}
