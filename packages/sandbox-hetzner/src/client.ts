/**
 * Hetzner Cloud REST API client — hand-rolled fetch wrapper.
 *
 * Why not an SDK: the Hetzner SDK options are limited (no official JS SDK
 * with strict types at the time of writing), and the subset of the API we
 * need is small (servers, images, firewalls, plus a handful of read-only
 * lookups). A hand-rolled client gives us strict typing of just the fields
 * we touch, no heavy dep tree, and full control over the retry wrapper.
 *
 * Auth: bearer token in `HCLOUD_TOKEN` env. The env-loader pulls it from
 * `~/.agentbox/secrets.env` so the user only sets it once via
 * `agentbox hetzner login`.
 *
 * Errors: REST responses get unwrapped into typed `HetznerApiError`s that
 * carry the response `status` + the API's `error.code` / `error.message`.
 * Network failures bubble up as raw `Error`s with a `code` property
 * (ECONNRESET, ETIMEDOUT, …) — the retry wrapper classifies both shapes.
 */

import { ensureHetznerEnvLoaded } from './env-loader.js';

export const DEFAULT_HCLOUD_ENDPOINT = 'https://api.hetzner.cloud/v1';

/**
 * Coarse Hetzner Cloud Server lifecycle states we care about. Hetzner has a
 * dozen finer-grained ones (`initializing`, `migrating`, `rebuilding`, …);
 * we map them in `backend.ts` to the four-value `CloudState` everyone else
 * consumes. Listed here so the client return types stay narrow.
 */
export type HetznerServerStatus =
  | 'running'
  | 'initializing'
  | 'starting'
  | 'stopping'
  | 'off'
  | 'deleting'
  | 'migrating'
  | 'rebuilding'
  | 'unknown';

export interface HetznerServer {
  id: number;
  name: string;
  status: HetznerServerStatus;
  created: string;
  public_net: {
    ipv4: { ip: string; blocked: boolean } | null;
    ipv6: { ip: string; blocked: boolean } | null;
  };
  server_type: { name: string; cores: number; memory: number; disk: number };
  image: { id: number; name?: string; description?: string; type: string } | null;
  labels: Record<string, string>;
}

export interface HetznerAction {
  id: number;
  command: string;
  status: 'running' | 'success' | 'error';
  progress: number;
  error?: { code: string; message: string };
}

export interface HetznerImage {
  id: number;
  type: 'system' | 'snapshot' | 'backup' | 'app';
  status: 'available' | 'creating' | 'unavailable';
  name?: string;
  description: string;
  image_size?: number;
  disk_size: number;
  /** CPU architecture the image is built for. Snapshots inherit the source VPS. */
  architecture?: 'x86' | 'arm';
  created: string;
  labels: Record<string, string>;
  bound_to?: number;
}

/**
 * A Hetzner server type (VPS plan), narrowed to the fields the preflight
 * validator reads. `memory`/`disk` are GB (memory is a float, e.g. `4`, `7.75`).
 * `prices[].location` is the authoritative "offered here" list. `deprecation`
 * is a non-null object once the type is on the deprecation path (the legacy
 * `deprecated` boolean mirrors it). See GET /server_types.
 */
export interface HetznerServerType {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
  architecture: 'x86' | 'arm';
  deprecated?: boolean;
  deprecation?: { announced?: string; unavailable_after?: string } | null;
  prices: Array<{ location: string }>;
}

export interface HetznerFirewall {
  id: number;
  name: string;
  rules: HetznerFirewallRule[];
  applied_to: Array<{ type: 'server'; server: { id: number } }>;
}

export interface HetznerFirewallRule {
  direction: 'in' | 'out';
  protocol: 'tcp' | 'udp' | 'icmp' | 'esp' | 'gre';
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string;
}

export interface HetznerSshKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
  labels: Record<string, string>;
}

export interface CreateServerRequest {
  name: string;
  server_type: string;
  image: string | number;
  location?: string;
  datacenter?: string;
  user_data?: string;
  ssh_keys?: Array<string | number>;
  firewalls?: Array<{ firewall: number }>;
  labels?: Record<string, string>;
  start_after_create?: boolean;
  public_net?: {
    enable_ipv4?: boolean;
    enable_ipv6?: boolean;
  };
}

export interface CreateFirewallRequest {
  name: string;
  rules: HetznerFirewallRule[];
  labels?: Record<string, string>;
  apply_to?: Array<{ type: 'server'; server: { id: number } }>;
}

/**
 * Strongly-typed Hetzner API error. The Hetzner API consistently returns
 * `{ error: { code, message, details? } }` for 4xx/5xx (https://docs.hetzner.cloud/#errors).
 * We unwrap that into this class so callers can do `instanceof
 * HetznerApiError` and inspect `.code` / `.statusCode` without parsing the
 * body again.
 */
export class HetznerApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(`hetzner ${String(statusCode)} ${code}: ${message}`);
    this.name = 'HetznerApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Subset of the Hetzner Cloud API the agentbox provider talks to. Methods
 * map 1:1 to REST endpoints; each operation is small + idempotent-where-the-
 * API-is-idempotent. The retry wrapper around the provider methods handles
 * transient 5xx / connection failures.
 */
export interface HetznerClient {
  /** GET /servers/{id}. Returns null on 404 so callers don't have to try/catch. */
  getServer(id: number): Promise<HetznerServer | null>;
  /** POST /servers. Returns the created server + the create action handle. */
  createServer(req: CreateServerRequest): Promise<{ server: HetznerServer; action: HetznerAction }>;
  /** GET /servers (with optional label selector). */
  listServers(opts?: { label_selector?: string }): Promise<HetznerServer[]>;
  /** DELETE /servers/{id}. Returns the action handle. Idempotent on 404. */
  deleteServer(id: number): Promise<HetznerAction | null>;
  /** POST /servers/{id}/actions/poweron. */
  powerOn(id: number): Promise<HetznerAction>;
  /** POST /servers/{id}/actions/poweroff. */
  powerOff(id: number): Promise<HetznerAction>;
  /** POST /servers/{id}/actions/shutdown — graceful, sends ACPI. */
  shutdown(id: number): Promise<HetznerAction>;
  /** POST /servers/{id}/actions/create_image — snapshot of the live disk. */
  createImage(
    id: number,
    body: { type: 'snapshot' | 'backup'; description?: string; labels?: Record<string, string> },
  ): Promise<{ image: HetznerImage; action: HetznerAction }>;
  /** GET /images/{id}. Returns null on 404. */
  getImage(id: number): Promise<HetznerImage | null>;
  /** GET /server_types — the VPS-plan catalog (paginated). Used by the create preflight. */
  listServerTypes(): Promise<HetznerServerType[]>;
  /** GET /images (filterable). */
  listImages(opts?: {
    type?: 'system' | 'snapshot' | 'backup' | 'app';
    label_selector?: string;
    name?: string;
  }): Promise<HetznerImage[]>;
  /** DELETE /images/{id}. Idempotent on 404. */
  deleteImage(id: number): Promise<void>;
  /** POST /firewalls. */
  createFirewall(req: CreateFirewallRequest): Promise<HetznerFirewall>;
  /** POST /firewalls/{id}/actions/set_rules. Replaces the entire rule set. */
  setFirewallRules(id: number, rules: HetznerFirewallRule[]): Promise<HetznerAction[]>;
  /** GET /firewalls/{id}. Returns null on 404. */
  getFirewall(id: number): Promise<HetznerFirewall | null>;
  /** DELETE /firewalls/{id}. Idempotent on 404. */
  deleteFirewall(id: number): Promise<void>;
  /**
   * GET /locations — used by `agentbox hetzner login` to validate the token
   * with a cheap unauthenticated-shape call (the endpoint requires a valid
   * token but returns a small, stable response).
   */
  listLocations(): Promise<Array<{ id: number; name: string; city: string; country: string }>>;
}

interface MakeClientOptions {
  /** Override the bearer token (else read from `HCLOUD_TOKEN`). */
  token?: string;
  /** Override the API base URL (else read from `HCLOUD_ENDPOINT` or use the default). */
  endpoint?: string;
  /** Per-request fetch impl (tests inject this). */
  fetchImpl?: typeof fetch;
}

/**
 * Build a Hetzner Cloud client bound to the current `HCLOUD_TOKEN`. The token
 * is resolved at construction time, so re-running `agentbox hetzner login` in
 * the middle of a long-lived process won't pick up the new token without a
 * fresh `makeHetznerClient()` call (we accept this — the CLI re-imports the
 * provider on each invocation).
 */
export function makeHetznerClient(opts: MakeClientOptions = {}): HetznerClient {
  ensureHetznerEnvLoaded();
  const rawToken = opts.token ?? process.env.HCLOUD_TOKEN;
  if (!rawToken || rawToken.trim().length === 0) {
    throw new Error(
      'Hetzner credentials not configured: HCLOUD_TOKEN is empty.\n' +
        'Run `agentbox hetzner login` interactively, or set HCLOUD_TOKEN in the environment.',
    );
  }
  // Bind to a const so the type narrows for the closures below — without
  // this the `req()` closure sees the original `string | undefined` shape.
  const token: string = rawToken.trim();
  const endpoint = (opts.endpoint ?? process.env.HCLOUD_ENDPOINT ?? DEFAULT_HCLOUD_ENDPOINT).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function req<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = `${endpoint}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await fetchImpl(url, init);
    if (res.status === 204) return null;
    if (res.status === 404) return null;
    if (!res.ok) {
      let parsed: { error?: { code?: string; message?: string; details?: unknown } } = {};
      try {
        parsed = (await res.json()) as typeof parsed;
      } catch {
        // body wasn't json
      }
      const code = parsed.error?.code ?? `http_${String(res.status)}`;
      const msg = parsed.error?.message ?? res.statusText ?? 'unknown error';
      throw new HetznerApiError(res.status, code, msg, parsed.error?.details);
    }
    const text = await res.text();
    if (text.length === 0) return null;
    return JSON.parse(text) as T;
  }

  async function reqExpect<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const out = await req<T>(method, path, body);
    if (out === null) {
      throw new HetznerApiError(0, 'empty_response', `expected a body from ${method} ${path}`);
    }
    return out;
  }

  return {
    async getServer(id) {
      const r = await req<{ server: HetznerServer }>('GET', `/servers/${String(id)}`);
      return r?.server ?? null;
    },
    async createServer(reqBody) {
      const r = await reqExpect<{ server: HetznerServer; action: HetznerAction }>(
        'POST',
        '/servers',
        reqBody,
      );
      return { server: r.server, action: r.action };
    },
    async listServers(opts) {
      const params = new URLSearchParams();
      if (opts?.label_selector) params.set('label_selector', opts.label_selector);
      params.set('per_page', '50');
      const all: HetznerServer[] = [];
      let pageNum = 1;
      while (true) {
        params.set('page', String(pageNum));
        const r = await reqExpect<{
          servers: HetznerServer[];
          meta?: { pagination?: { next_page?: number | null } };
        }>('GET', `/servers?${params.toString()}`);
        all.push(...r.servers);
        const next = r.meta?.pagination?.next_page;
        if (typeof next !== 'number') break;
        pageNum = next;
      }
      return all;
    },
    async deleteServer(id) {
      const r = await req<{ action: HetznerAction }>('DELETE', `/servers/${String(id)}`);
      return r?.action ?? null;
    },
    async powerOn(id) {
      const r = await reqExpect<{ action: HetznerAction }>(
        'POST',
        `/servers/${String(id)}/actions/poweron`,
      );
      return r.action;
    },
    async powerOff(id) {
      const r = await reqExpect<{ action: HetznerAction }>(
        'POST',
        `/servers/${String(id)}/actions/poweroff`,
      );
      return r.action;
    },
    async shutdown(id) {
      const r = await reqExpect<{ action: HetznerAction }>(
        'POST',
        `/servers/${String(id)}/actions/shutdown`,
      );
      return r.action;
    },
    async createImage(id, body) {
      const r = await reqExpect<{ image: HetznerImage; action: HetznerAction }>(
        'POST',
        `/servers/${String(id)}/actions/create_image`,
        body,
      );
      return { image: r.image, action: r.action };
    },
    async getImage(id) {
      const r = await req<{ image: HetznerImage }>('GET', `/images/${String(id)}`);
      return r?.image ?? null;
    },
    async listServerTypes() {
      const params = new URLSearchParams();
      params.set('per_page', '50');
      const all: HetznerServerType[] = [];
      let pageNum = 1;
      while (true) {
        params.set('page', String(pageNum));
        const r = await reqExpect<{
          server_types: HetznerServerType[];
          meta?: { pagination?: { next_page?: number | null } };
        }>('GET', `/server_types?${params.toString()}`);
        all.push(...r.server_types);
        const next = r.meta?.pagination?.next_page;
        if (typeof next !== 'number') break;
        pageNum = next;
      }
      return all;
    },
    async listImages(opts) {
      const params = new URLSearchParams();
      if (opts?.type) params.set('type', opts.type);
      if (opts?.label_selector) params.set('label_selector', opts.label_selector);
      if (opts?.name) params.set('name', opts.name);
      params.set('per_page', '50');
      const all: HetznerImage[] = [];
      let pageNum = 1;
      while (true) {
        params.set('page', String(pageNum));
        const r = await reqExpect<{
          images: HetznerImage[];
          meta?: { pagination?: { next_page?: number | null } };
        }>('GET', `/images?${params.toString()}`);
        all.push(...r.images);
        const next = r.meta?.pagination?.next_page;
        if (typeof next !== 'number') break;
        pageNum = next;
      }
      return all;
    },
    async deleteImage(id) {
      await req<unknown>('DELETE', `/images/${String(id)}`);
    },
    async createFirewall(reqBody) {
      const r = await reqExpect<{ firewall: HetznerFirewall }>('POST', '/firewalls', reqBody);
      return r.firewall;
    },
    async setFirewallRules(id, rules) {
      const r = await reqExpect<{ actions: HetznerAction[] }>(
        'POST',
        `/firewalls/${String(id)}/actions/set_rules`,
        { rules },
      );
      return r.actions;
    },
    async getFirewall(id) {
      const r = await req<{ firewall: HetznerFirewall }>('GET', `/firewalls/${String(id)}`);
      return r?.firewall ?? null;
    },
    async deleteFirewall(id) {
      await req<unknown>('DELETE', `/firewalls/${String(id)}`);
    },
    async listLocations() {
      const r = await reqExpect<{
        locations: Array<{ id: number; name: string; city: string; country: string }>;
      }>('GET', '/locations');
      return r.locations;
    },
  };
}
