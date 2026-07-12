/**
 * DigitalOcean API v2 REST client — hand-rolled fetch wrapper.
 *
 * Why not an SDK: the subset of the API we need is small (droplets, droplet
 * actions, snapshots, firewalls, plus a cheap `account` lookup for token
 * validation). A hand-rolled client gives us strict typing of just the
 * fields we touch, no heavy dep tree, and full control over the retry
 * wrapper. Mirrors `sandbox-hetzner/src/client.ts` in shape.
 *
 * Auth: bearer token in `DIGITALOCEAN_TOKEN` env. The env-loader pulls it
 * from `~/.agentbox/secrets.env` so the user only sets it once via
 * `agentbox digitalocean login`.
 *
 * Errors: REST responses get unwrapped into typed `DigitalOceanApiError`s
 * that carry the response `status` + the API's `{ id, message }` body
 * (https://docs.digitalocean.com/reference/api/api-reference/#section/Introduction/Responses).
 * Network failures bubble up as raw `Error`s with a `code` property
 * (ECONNRESET, ETIMEDOUT, …) — the retry wrapper classifies both shapes.
 */

import { ensureDigitalOceanEnvLoaded } from './env-loader.js';

export const DEFAULT_DO_ENDPOINT = 'https://api.digitalocean.com/v2';

/**
 * DigitalOcean Droplet lifecycle states. `new` = provisioning (no network
 * yet), `active` = running, `off` = powered off, `archive` = archived/locked.
 * Mapped in `backend.ts` to the four-value `CloudState` everyone else
 * consumes.
 */
export type DigitalOceanDropletStatus = 'new' | 'active' | 'off' | 'archive';

export interface DigitalOceanNetworkV4 {
  ip_address: string;
  netmask: string;
  gateway: string;
  type: 'public' | 'private';
}

export interface DigitalOceanDroplet {
  id: number;
  name: string;
  status: DigitalOceanDropletStatus;
  created_at: string;
  networks: {
    v4: DigitalOceanNetworkV4[];
    v6: Array<{ ip_address: string; type: 'public' | 'private' }>;
  };
  image: { id: number; slug: string | null; distribution?: string; name?: string } | null;
  size_slug: string;
  region: { slug: string; name: string } | null;
  tags: string[];
}

export interface DigitalOceanAction {
  id: number;
  status: 'in-progress' | 'completed' | 'errored';
  type: string;
  resource_id: number;
  resource_type: string;
  region_slug?: string;
}

export interface DigitalOceanSnapshot {
  /** Snapshot id — a numeric *string* in DigitalOcean's API (e.g. "119192817"). */
  id: string;
  name: string;
  created_at: string;
  regions: string[];
  resource_id: string;
  resource_type: 'droplet';
  min_disk_size: number;
  size_gigabytes: number;
}

/**
 * A DigitalOcean Droplet size (plan), narrowed to the fields the create
 * preflight reads. `memory` is MB (DO reports it that way); `disk` is GB;
 * `regions` is the authoritative "offered here" list; `available` is false for
 * sold-out / retired plans. See GET /v2/sizes.
 */
export interface DigitalOceanSize {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  available: boolean;
  regions: string[];
  description?: string;
}

/**
 * A DigitalOcean Project — the account's resource-grouping unit (billing /
 * visibility). `id` is a UUID. Exactly one project has `is_default`, and every
 * resource lands there unless assigned elsewhere. See GET /v2/projects.
 */
export interface DigitalOceanProject {
  id: string;
  name: string;
  is_default: boolean;
  purpose?: string;
  environment?: string;
}

/**
 * A firewall rule's source (inbound) / destination (outbound) selector.
 * `addresses` accepts IPv4/IPv6 + CIDR; `tags` auto-includes droplets.
 */
export interface DigitalOceanFirewallEndpoint {
  addresses?: string[];
  droplet_ids?: number[];
  tags?: string[];
  load_balancer_uids?: string[];
}

export interface DigitalOceanInboundRule {
  protocol: 'tcp' | 'udp' | 'icmp';
  /** Port range as a string ("22", "1-65535"). Omitted for icmp. */
  ports?: string;
  sources: DigitalOceanFirewallEndpoint;
}

export interface DigitalOceanOutboundRule {
  protocol: 'tcp' | 'udp' | 'icmp';
  ports?: string;
  destinations: DigitalOceanFirewallEndpoint;
}

export interface DigitalOceanFirewall {
  /** Firewall id — a UUID *string* in DigitalOcean's API. */
  id: string;
  name: string;
  status: 'waiting' | 'succeeded' | 'failed';
  inbound_rules: DigitalOceanInboundRule[];
  outbound_rules: DigitalOceanOutboundRule[];
  droplet_ids: number[];
  tags: string[];
}

export interface CreateDropletRequest {
  name: string;
  region: string;
  size: string;
  /** Image slug (e.g. `ubuntu-24-04-x64`) or a numeric snapshot/image id. */
  image: string | number;
  user_data?: string;
  ssh_keys?: Array<string | number>;
  tags?: string[];
  ipv6?: boolean;
  backups?: boolean;
}

export interface CreateFirewallRequest {
  name: string;
  inbound_rules: DigitalOceanInboundRule[];
  outbound_rules: DigitalOceanOutboundRule[];
  droplet_ids?: number[];
  tags?: string[];
}

/**
 * Strongly-typed DigitalOcean API error. The API returns `{ id, message,
 * request_id }` for 4xx/5xx. We unwrap that into this class so callers can
 * do `instanceof DigitalOceanApiError` and inspect `.code` (the API's `id`)
 * / `.statusCode` without parsing the body again.
 */
export class DigitalOceanApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId?: string;
  constructor(statusCode: number, code: string, message: string, requestId?: string) {
    super(`digitalocean ${String(statusCode)} ${code}: ${message}`);
    this.name = 'DigitalOceanApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface DigitalOceanAccount {
  uuid: string;
  email: string;
  status: string;
  droplet_limit: number;
}

/**
 * Subset of the DigitalOcean API v2 the agentbox provider talks to. Methods
 * map 1:1 to REST endpoints; the retry wrapper around the provider methods
 * handles transient 5xx / 429 / connection failures.
 */
export interface DigitalOceanClient {
  /** GET /account — cheap auth-validation call for `agentbox digitalocean login`. */
  getAccount(): Promise<DigitalOceanAccount>;
  /** GET /droplets/{id}. Returns null on 404. */
  getDroplet(id: number): Promise<DigitalOceanDroplet | null>;
  /** POST /droplets. Returns the created droplet + the create-action id (if any). */
  createDroplet(req: CreateDropletRequest): Promise<{ droplet: DigitalOceanDroplet; actionId: number | null }>;
  /** GET /droplets (optionally filtered by a single tag). Paginates. */
  listDroplets(opts?: { tag_name?: string }): Promise<DigitalOceanDroplet[]>;
  /** DELETE /droplets/{id}. Idempotent on 404. */
  deleteDroplet(id: number): Promise<void>;
  /** POST /droplets/{id}/actions {type:'power_on'}. */
  powerOn(id: number): Promise<DigitalOceanAction>;
  /** POST /droplets/{id}/actions {type:'power_off'} — hard power off. */
  powerOff(id: number): Promise<DigitalOceanAction>;
  /** POST /droplets/{id}/actions {type:'shutdown'} — graceful ACPI shutdown. */
  shutdown(id: number): Promise<DigitalOceanAction>;
  /** POST /droplets/{id}/actions {type:'snapshot', name}. */
  snapshotDroplet(id: number, name: string): Promise<DigitalOceanAction>;
  /** GET /actions/{id}. Returns null on 404. */
  getAction(id: number): Promise<DigitalOceanAction | null>;
  /** GET /snapshots?resource_type=droplet. Paginates. */
  listSnapshots(): Promise<DigitalOceanSnapshot[]>;
  /** GET /snapshots/{id}. Returns null on 404. */
  getSnapshot(id: string): Promise<DigitalOceanSnapshot | null>;
  /** DELETE /snapshots/{id}. Idempotent on 404. */
  deleteSnapshot(id: string): Promise<void>;
  /** GET /sizes — the Droplet-plan catalog (paginated). Used by the create preflight. */
  listSizes(): Promise<DigitalOceanSize[]>;
  /** GET /projects — the account's projects (paginated). Used by the create preflight + login picker. */
  listProjects(): Promise<DigitalOceanProject[]>;
  /** GET /projects/default — the project resources land in when unassigned. Returns null on 404. */
  getDefaultProject(): Promise<DigitalOceanProject | null>;
  /**
   * POST /projects/{id}/resources — move resources into a project. DO has no
   * project field on droplet-create, so this is the only way in, and it can only
   * run once the droplet exists.
   */
  assignProjectResources(projectId: string, urns: string[]): Promise<void>;
  /** POST /firewalls. */
  createFirewall(req: CreateFirewallRequest): Promise<DigitalOceanFirewall>;
  /** GET /firewalls/{id}. Returns null on 404. */
  getFirewall(id: string): Promise<DigitalOceanFirewall | null>;
  /** GET /firewalls. Paginates. */
  listFirewalls(): Promise<DigitalOceanFirewall[]>;
  /** PUT /firewalls/{id}. Full replacement of the firewall's rules/name/tags. */
  updateFirewall(id: string, req: CreateFirewallRequest): Promise<DigitalOceanFirewall>;
  /** DELETE /firewalls/{id}. Idempotent on 404. */
  deleteFirewall(id: string): Promise<void>;
  /**
   * POST /tags — create a tag. DigitalOcean requires a tag to EXIST before it
   * can be referenced by a firewall or a droplet's `tags`, so the per-box
   * firewall flow creates its tag first. Idempotent: a 422 "already exists"
   * is swallowed (re-provision / retry safe).
   */
  createTag(name: string): Promise<void>;
  /** DELETE /tags/{name}. Idempotent on 404 (already gone). */
  deleteTag(name: string): Promise<void>;
}

interface MakeClientOptions {
  /** Override the bearer token (else read from `DIGITALOCEAN_TOKEN`). */
  token?: string;
  /** Override the API base URL (else read from `DIGITALOCEAN_API_URL` or use the default). */
  endpoint?: string;
  /** Per-request fetch impl (tests inject this). */
  fetchImpl?: typeof fetch;
}

/**
 * Build a DigitalOcean client bound to the current `DIGITALOCEAN_TOKEN`. The
 * token is resolved at construction time, so re-running `agentbox
 * digitalocean login` mid-process won't pick up the new token without a
 * fresh `makeDigitalOceanClient()` call (we accept this — the CLI re-imports
 * the provider on each invocation).
 */
export function makeDigitalOceanClient(opts: MakeClientOptions = {}): DigitalOceanClient {
  ensureDigitalOceanEnvLoaded();
  const rawToken = opts.token ?? process.env.DIGITALOCEAN_TOKEN;
  if (!rawToken || rawToken.trim().length === 0) {
    throw new Error(
      'DigitalOcean credentials not configured: DIGITALOCEAN_TOKEN is empty.\n' +
        'Run `agentbox digitalocean login` interactively, or set DIGITALOCEAN_TOKEN in the environment.',
    );
  }
  const token: string = rawToken.trim();
  const endpoint = (opts.endpoint ?? process.env.DIGITALOCEAN_API_URL ?? DEFAULT_DO_ENDPOINT).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function req<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = path.startsWith('http') ? path : `${endpoint}${path}`;
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
      let parsed: { id?: string; message?: string; request_id?: string } = {};
      try {
        parsed = (await res.json()) as typeof parsed;
      } catch {
        // body wasn't json
      }
      const code = parsed.id ?? `http_${String(res.status)}`;
      const msg = parsed.message ?? res.statusText ?? 'unknown error';
      throw new DigitalOceanApiError(res.status, code, msg, parsed.request_id);
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
      throw new DigitalOceanApiError(0, 'empty_response', `expected a body from ${method} ${path}`);
    }
    return out;
  }

  /**
   * Page through a list endpoint. DigitalOcean returns `{ <key>: [...],
   * links: { pages: { next } }, meta: { total } }`. We follow `links.pages.next`
   * (a full URL) until it's absent.
   */
  async function paginate<T>(firstPath: string, key: string): Promise<T[]> {
    const all: T[] = [];
    let next: string | undefined = firstPath;
    while (next) {
      const r: Record<string, unknown> = await reqExpect<Record<string, unknown>>('GET', next);
      const page = (r[key] as T[] | undefined) ?? [];
      all.push(...page);
      const links = r.links as { pages?: { next?: string } } | undefined;
      next = links?.pages?.next;
    }
    return all;
  }

  function withPerPage(path: string): string {
    return path.includes('?') ? `${path}&per_page=200` : `${path}?per_page=200`;
  }

  async function dropletAction(id: number, payload: Record<string, unknown>): Promise<DigitalOceanAction> {
    const r = await reqExpect<{ action: DigitalOceanAction }>(
      'POST',
      `/droplets/${String(id)}/actions`,
      payload,
    );
    return r.action;
  }

  return {
    async getAccount() {
      const r = await reqExpect<{ account: DigitalOceanAccount }>('GET', '/account');
      return r.account;
    },
    async getDroplet(id) {
      const r = await req<{ droplet: DigitalOceanDroplet }>('GET', `/droplets/${String(id)}`);
      return r?.droplet ?? null;
    },
    async createDroplet(reqBody) {
      const r = await reqExpect<{
        droplet: DigitalOceanDroplet;
        links?: { actions?: Array<{ id: number; rel: string }> };
      }>('POST', '/droplets', reqBody);
      const createAction = r.links?.actions?.find((a) => a.rel === 'create') ?? r.links?.actions?.[0];
      return { droplet: r.droplet, actionId: createAction?.id ?? null };
    },
    async listDroplets(opts) {
      const base = opts?.tag_name
        ? `/droplets?tag_name=${encodeURIComponent(opts.tag_name)}`
        : '/droplets';
      return paginate<DigitalOceanDroplet>(withPerPage(base), 'droplets');
    },
    async deleteDroplet(id) {
      await req<unknown>('DELETE', `/droplets/${String(id)}`);
    },
    async powerOn(id) {
      return dropletAction(id, { type: 'power_on' });
    },
    async powerOff(id) {
      return dropletAction(id, { type: 'power_off' });
    },
    async shutdown(id) {
      return dropletAction(id, { type: 'shutdown' });
    },
    async snapshotDroplet(id, name) {
      return dropletAction(id, { type: 'snapshot', name });
    },
    async getAction(id) {
      const r = await req<{ action: DigitalOceanAction }>('GET', `/actions/${String(id)}`);
      return r?.action ?? null;
    },
    async listSnapshots() {
      return paginate<DigitalOceanSnapshot>(
        withPerPage('/snapshots?resource_type=droplet'),
        'snapshots',
      );
    },
    async getSnapshot(id) {
      const r = await req<{ snapshot: DigitalOceanSnapshot }>('GET', `/snapshots/${encodeURIComponent(id)}`);
      return r?.snapshot ?? null;
    },
    async deleteSnapshot(id) {
      await req<unknown>('DELETE', `/snapshots/${encodeURIComponent(id)}`);
    },
    async listSizes() {
      return paginate<DigitalOceanSize>(withPerPage('/sizes'), 'sizes');
    },
    async listProjects() {
      return paginate<DigitalOceanProject>(withPerPage('/projects'), 'projects');
    },
    async getDefaultProject() {
      const r = await req<{ project: DigitalOceanProject }>('GET', '/projects/default');
      return r?.project ?? null;
    },
    async assignProjectResources(projectId, urns) {
      await req<unknown>('POST', `/projects/${encodeURIComponent(projectId)}/resources`, {
        resources: urns,
      });
    },
    async createFirewall(reqBody) {
      const r = await reqExpect<{ firewall: DigitalOceanFirewall }>('POST', '/firewalls', reqBody);
      return r.firewall;
    },
    async getFirewall(id) {
      const r = await req<{ firewall: DigitalOceanFirewall }>('GET', `/firewalls/${encodeURIComponent(id)}`);
      return r?.firewall ?? null;
    },
    async listFirewalls() {
      return paginate<DigitalOceanFirewall>(withPerPage('/firewalls'), 'firewalls');
    },
    async updateFirewall(id, reqBody) {
      const r = await reqExpect<{ firewall: DigitalOceanFirewall }>(
        'PUT',
        `/firewalls/${encodeURIComponent(id)}`,
        reqBody,
      );
      return r.firewall;
    },
    async deleteFirewall(id) {
      await req<unknown>('DELETE', `/firewalls/${encodeURIComponent(id)}`);
    },
    async createTag(name) {
      try {
        await req<unknown>('POST', '/tags', { name });
      } catch (err) {
        // A tag that already exists returns 422 — treat as success so
        // re-provision / retry paths don't fail on an existing tag.
        if (err instanceof DigitalOceanApiError && err.statusCode === 422) return;
        throw err;
      }
    },
    async deleteTag(name) {
      await req<unknown>('DELETE', `/tags/${encodeURIComponent(name)}`);
    },
  };
}
