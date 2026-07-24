/**
 * The PC's client for a hub's public REST API (`/api/v1`) — the SAME surface the
 * tray and web UI speak. Its only local⇄remote difference is the base URL + token
 * (a control box's `AGENTBOX_HUB_API_KEY`, or a local hub's token), so a command
 * built on this client works against either by swapping the target.
 *
 * Distinct from {@link ControlPlaneAdminClient}, which speaks the INTERNAL relay
 * wire (`/admin/*` + `/remote/*`) — the box↔hub + credential plane that is not a
 * client API. Client-facing box operations (list, lifecycle, git, approvals)
 * belong here; custody / registration / RPC-lease stay on the admin client.
 */

/** A hub box as the `/api/v1` list/get returns it (the UI view + raw host fields). */
export interface HubApiBox {
  id: string;
  name?: string;
  provider: string;
  /** Raw provider runtime state; absent on synthetic in-flight `job:` boxes. */
  state?: 'running' | 'paused' | 'stopped' | 'missing' | 'destroyed';
  /** Normalized lifecycle status (running | paused | stopped | creating | error). */
  status: string;
  branch: string;
  task: string;
  projectRoot?: string;
  projectIndex?: number;
}

/** A create-job's status as `/api/v1/jobs/:id` returns it. */
export interface HubApiJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | string;
  boxId?: string;
  login?: {
    required?: boolean;
    phase?: string;
    url?: string;
    error?: string;
    lastError?: string;
  };
}

/** A pending host-action approval as `/api/v1/approvals` returns it. */
export interface HubApiApproval {
  id: string;
  boxId: string;
  message: string;
  detail?: string;
  command?: string;
  cwd?: string;
  argv?: string[];
  defaultAnswer: 'y' | 'n';
  createdAt: number;
}

/** Result of a box git/service op (mirrors the backend `BoxOpResult`). */
export interface HubApiOpResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type HubLifecycleAction = 'start' | 'pause' | 'resume' | 'stop' | 'destroy';
export type HubGitOp = 'checkout' | 'branch' | 'pull' | 'push' | 'push-host';

export interface HubApiTarget {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** An error carrying the `/api/v1` envelope's code + HTTP status. */
export class HubApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HubApiError';
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class HubApiClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(target: HubApiTarget) {
    this.base = target.url.replace(/\/+$/, '');
    this.token = target.apiKey;
    this.fetchImpl = target.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new HubApiError(`unexpected non-JSON response (${res.status})`, 'internal', res.status);
    }
    if (!res.ok) {
      const err = (parsed as ApiErrorBody).error;
      throw new HubApiError(
        err?.message ?? `request failed: ${res.status}`,
        err?.code ?? 'internal',
        res.status,
      );
    }
    return parsed as T;
  }

  /** All boxes the hub knows (its own + registered). Topology-agnostic read. */
  async listBoxes(): Promise<HubApiBox[]> {
    return (await this.request<{ boxes: HubApiBox[] }>('GET', '/boxes')).boxes;
  }

  /** One box by id (throws HubApiError 'not_found' when absent). */
  getBox(id: string): Promise<HubApiBox> {
    return this.request<HubApiBox>('GET', `/boxes/${encodeURIComponent(id)}`);
  }

  /** Lifecycle action on a box. Reverse-adoption lets the hub drive registered-only boxes. */
  async lifecycle(id: string, action: HubLifecycleAction): Promise<void> {
    await this.request<{ ok: true }>('POST', `/boxes/${encodeURIComponent(id)}/${action}`);
  }

  /** Real destroy: tears down the cloud resource AND reaps the hub's registration/custody. */
  destroy(id: string): Promise<void> {
    return this.lifecycle(id, 'destroy');
  }

  /** A git op against the box's branch. */
  git(id: string, op: HubGitOp, body: Record<string, unknown> = {}): Promise<HubApiOpResult> {
    return this.request<HubApiOpResult>('POST', `/boxes/${encodeURIComponent(id)}/git/${op}`, body);
  }

  /** Create-job status (poll until done/failed). */
  getJob(id: string): Promise<HubApiJob> {
    return this.request<HubApiJob>('GET', `/jobs/${encodeURIComponent(id)}`);
  }

  /** Pending host-action approvals across every box. */
  async listApprovals(): Promise<HubApiApproval[]> {
    return (await this.request<{ approvals: HubApiApproval[] }>('GET', '/approvals')).approvals;
  }

  /** Answer a pending approval by id. */
  async answerApproval(id: string, answer: 'y' | 'n'): Promise<void> {
    await this.request<{ ok: true }>('POST', `/approvals/${encodeURIComponent(id)}/answer`, { answer });
  }
}
