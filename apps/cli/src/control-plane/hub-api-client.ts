/**
 * The PC's client for a hub's public REST API (`/api/v1`) — the SAME surface the
 * tray and web UI speak. Its only local⇄remote difference is the base URL + token
 * (a control box's `AGENTBOX_HUB_API_KEY`, or a local hub's token), so a command
 * built on this client works against either by swapping the target.
 *
 * This is the CLI's ONE client. The internal relay wire (`/admin/*` + `/remote/*`)
 * is the box↔hub + credential plane — not a client API — and after the `/api/v1`
 * consolidation the CLI no longer holds a client for it (a guard test enforces
 * this; see `test/no-internal-wire-client.test.ts`). Every client-facing box and
 * fleet operation (list, lifecycle, git, approvals, custody) goes through here.
 */

/**
 * A hub box as the `/api/v1` list/get returns it (the UI view + raw host fields).
 * Mirrors the hub's own `Box` for the fields a CLI/tray client reads. The
 * "adoption / reconstruction" block is what lets a thin CLI (`agentbox ls`, and
 * Step 4's box resolution) rebuild a drivable local record from THIS payload
 * instead of the internal `/admin/store` registration wire — it carries every
 * NON-SECRET field `registrationToBoxRecord` needs. Tokens (relay/bridge/preview)
 * are deliberately absent: a fresh adoption re-mints them.
 */
export interface HubApiBox {
  id: string;
  name?: string;
  /** Cosmetic user label (set via rename); the CLI prefers it over `name`. */
  displayName?: string | null;
  /** The hub's computed primary label (displayName || session title || name). */
  task: string;
  provider: string;
  /** Raw provider runtime state; absent on synthetic in-flight `job:` boxes. */
  state?: 'running' | 'paused' | 'stopped' | 'missing' | 'destroyed';
  /** Normalized lifecycle status (running | paused | stopped | creating | error). */
  status: string;
  branch: string;
  /** Absolute host path of the box's project — host topology only. */
  projectRoot?: string;
  projectIndex?: number;
  createdAt?: number;
  /** Normalized primary agent for display ('claude' | 'codex' | 'opencode' | 'shell'). */
  agent?: string;
  // ── Agent activity / session titles (the AGENT column + cmux dock). ──
  claudeActivity?: string;
  codexActivity?: string;
  claudeSessionTitle?: string;
  codexSessionTitle?: string;
  opencodeSessionTitle?: string;
  /** Live shell-session count (docker only); absent → the CLI renders `-`. */
  shellCount?: number;
  // ── Endpoints (the URL column; Step 7's `url`/`screen`). ──
  webUrl?: string | null;
  vncUrl?: string | null;
  vncEnabled?: boolean;
  // ── Adoption / reconstruction fields (non-secret; cloud boxes only, EXCEPT
  //    originUrl which is populated for any registered box, docker included). ──
  sandboxId?: string;
  // Repo origin URL — the cross-machine project key `list` scopes by when a box's
  // projectRoot names no local directory (it's a remote hub's own path).
  originUrl?: string | null;
  publicHost?: string;
  image?: string;
  webPort?: number;
  previewUrls?: Record<number, string>;
  lastAgent?: 'claude' | 'codex' | 'opencode';
  topology?: string;
}

/** A create-job's status as `/api/v1/jobs/:id` (and each row of `/api/v1/jobs`) returns it. */
export interface HubApiJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | string;
  boxId?: string;
  /** A failed job's reason — surfaced so a create reports a failure, not a silent "done". */
  error?: string;
  provider?: string;
  name?: string;
  agent?: string;
  createdAt?: string;
  login?: {
    required?: boolean;
    phase?: string;
    url?: string;
    error?: string;
    lastError?: string;
  };
}

/** Body for `POST /api/v1/boxes` — mirrors the hub's `CreateBoxInput`. */
export interface HubApiCreateBoxInput {
  /** Exactly one of projectId / repoUrl. */
  projectId?: string;
  repoUrl?: string;
  agent: 'claude' | 'codex' | 'opencode' | 'none';
  provider?: string;
  name?: string;
  prompt?: string;
  agentArgs?: string[];
  startAgent?: boolean;
  /** A foreground (interactive) create — the hub runs it in the ungated lane. */
  foreground?: boolean;
  fromBranch?: string;
  setupWizard?: boolean;
  /** Box-shaping knobs (image, snapshot, limits, size/location, carry, ...). */
  opts?: Record<string, unknown>;
}

/**
 * A sandbox provider as `/api/v1/providers` returns it. Mirrors the hub's own
 * `ProviderOption`; only the fields a CLI/tray client reads are named here.
 */
export interface HubApiProvider {
  id: string;
  label: string;
  /** Base baked (or, for remote-docker, at least one host registered). */
  configured: boolean;
  hasCredentials?: boolean;
  /** Id of a bake already in flight for this provider, if any. */
  jobId?: string;
  reason?: string;
  /** Only present when the caller asked for `?freshness=1`. */
  baseStatus?: 'fresh' | 'stale' | 'unprepared' | 'unknown';
  baseStaleReason?: string;
}

/** A remote-docker host alias as `/api/v1/hosts` returns it. */
export interface HubApiHost {
  alias: string;
  ssh?: string;
  baked?: boolean;
  default?: boolean;
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

/** One supervised service, as `GET /boxes/:id/services` returns it (mirrors the
 * backend `ServiceView`). The persisted-snapshot source fills pid/restarts/
 * lastExitCode/command with nulls/defaults. */
export interface HubApiServiceView {
  name: string;
  state: string;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
  blockedOn: string[];
  command: string;
}

/**
 * A box's agentbox.yaml task/service/port status (mirrors the backend
 * `ServicesResult`). `source` says whether it came from a live in-box pull, the
 * persisted snapshot (box paused/stopped), or is unavailable (box gone / never
 * reported).
 */
export interface HubApiServices {
  source: 'live' | 'persisted' | 'unavailable';
  services: HubApiServiceView[];
  tasks: { name: string; state: string }[];
  ports: { port: number; service: string | null }[];
  error?: string;
}

export type HubLifecycleAction = 'start' | 'pause' | 'resume' | 'stop' | 'destroy';
export type HubGitOp = 'checkout' | 'branch' | 'pull' | 'push' | 'push-host';

/** Result of `POST /boxes/:id/checkpoint` (a captured project checkpoint). */
export interface HubApiCheckpointCreate {
  ok: true;
  name: string;
  /** docker manifest type ('layered'/'merged') or 'snapshot' for a cloud backend. */
  kind: string;
  ref: string;
  provider: string;
  dir?: string;
  /** The default-checkpoint config key written when --set-default was requested. */
  setDefaultKey?: string;
}

/** One checkpoint row from `GET /checkpoints` (defaults resolved server-side). */
export interface HubApiCheckpointItem {
  name: string;
  provider: string;
  kind: string;
  sourceBoxName: string;
  createdAt: string;
  isDefault: boolean;
}

export interface HubApiCheckpointProject {
  segment: string;
  projectRoot?: string;
  label: string;
  items: HubApiCheckpointItem[];
}

export interface HubApiCheckpointListing {
  projects: HubApiCheckpointProject[];
}

/** Result of `DELETE /checkpoints` (removed backends + swept default pointers). */
export interface HubApiCheckpointRemove {
  ok: true;
  removed: string[];
  clearedKeys: string[];
  warnedKeys: string[];
}

/** The local (docker) prune tally — mirrors the backend PruneResultView. */
export interface HubApiPruneResult {
  removedRecords: string[];
  removedContainers: string[];
  removedVolumes: string[];
  removedSnapshotDirs: string[];
  removedBoxDirs: string[];
  removedCheckpointImages: string[];
  dryRun: boolean;
}

export interface HubApiPruneGeneral {
  kind: 'general';
  result: HubApiPruneResult;
  projectConfigs: string[];
}

export interface HubApiCloudOrphan {
  sandboxId: string;
  name?: string;
  state?: string;
  createdAt?: string;
}

export interface HubApiPruneCloud {
  kind: 'cloud';
  provider: string;
  dryRun: boolean;
  orphans: HubApiCloudOrphan[];
  deleted: number;
  failed: number;
  reaped: number;
}

export type HubApiPruneView = HubApiPruneGeneral | HubApiPruneCloud;

/** `GET /boxes/:id/agent` — the raw BoxStatusClaude snapshot (null = none yet). */
export interface HubApiAgentState {
  claude: unknown;
}

/** The unauthenticated liveness probe (`GET /api/v1/health`). */
export interface HubApiHealth {
  ok: boolean;
  /** The API contract the hub serves, e.g. `v1`. Gated against {@link SUPPORTED_HUB_API_VERSIONS}. */
  apiVersion: string;
  /** The AgentBox version the hub runs (a control box may differ from this CLI). */
  version?: string;
  profile?: string;
}

/**
 * The `/api/v1` contract versions this CLI knows how to speak. The hub reports its
 * own on `GET /api/v1/health` (`apiVersion`); a hub outside this set is refused up
 * front with an upgrade hint rather than failing on a missing/changed field later.
 */
export const SUPPORTED_HUB_API_VERSIONS = ['v1'] as const;

export interface HubApiTarget {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** An error carrying the `/api/v1` envelope's code + HTTP status (+ optional details). */
export class HubApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /**
     * The envelope's `error.details`, when present. Git ops carry the box
     * command's own `exitCode` here so a caller can surface a faithful exit
     * (e.g. 64 for `push --host-only` with no host checkout) that the coarse
     * code→exit mapping can't express.
     */
    readonly details?: unknown,
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
        err?.details,
      );
    }
    return parsed as T;
  }

  /**
   * Liveness + API-version probe. Unauthenticated on the hub (the Bearer we send
   * is harmless), so it also confirms the hub is reachable before an authed call.
   * Throws `HubApiError` on a non-2xx (e.g. a hub too old to expose `/api/v1`).
   */
  health(): Promise<HubApiHealth> {
    return this.request<HubApiHealth>('GET', '/health');
  }

  /**
   * All boxes the hub knows (its own + registered). Topology-agnostic read.
   * `live` (opt-in, expensive — mirrors `listProviders({ freshness })`) asks the
   * hub to refresh each cloud box's `state` with an authoritative SDK probe; the
   * default serves the fast persisted state.
   */
  async listBoxes(opts: { live?: boolean } = {}): Promise<HubApiBox[]> {
    const q = opts.live ? '?live=1' : '';
    return (await this.request<{ boxes: HubApiBox[] }>('GET', `/boxes${q}`)).boxes;
  }

  /** One box by id (throws HubApiError 'not_found' when absent). */
  getBox(id: string): Promise<HubApiBox> {
    return this.request<HubApiBox>('GET', `/boxes/${encodeURIComponent(id)}`);
  }

  /**
   * Resolve a box ref (`id | name | sandbox id | index`) server-side, mirroring
   * the CLI's local `findBox`. Returns the match SET: `[]`=none, `[box]`=unique,
   * `[…]`=an ambiguous id prefix (the caller disambiguates). `project` (an
   * absolute host project root) enables numeric project-index resolution.
   */
  async resolveBox(ref: string, project?: string): Promise<HubApiBox[]> {
    const q = new URLSearchParams({ ref });
    if (project !== undefined) q.set('project', project);
    return (await this.request<{ boxes: HubApiBox[] }>('GET', `/boxes?${q.toString()}`)).boxes;
  }

  /** Lifecycle action on a box. Reverse-adoption lets the hub drive registered-only boxes. */
  async lifecycle(id: string, action: HubLifecycleAction): Promise<void> {
    await this.request<{ ok: true }>('POST', `/boxes/${encodeURIComponent(id)}/${action}`);
  }

  /**
   * Real destroy: tears down the cloud resource AND reaps the hub's
   * registration/custody. `keepSnapshot` preserves a docker box's local snapshot
   * dir (mirrors the CLI's `--keep-snapshot`), so it travels on the request body.
   */
  async destroy(id: string, opts: { keepSnapshot?: boolean } = {}): Promise<void> {
    await this.request<{ ok: true }>('POST', `/boxes/${encodeURIComponent(id)}/destroy`, opts);
  }

  /** A git op against the box's branch. */
  git(id: string, op: HubGitOp, body: Record<string, unknown> = {}): Promise<HubApiOpResult> {
    return this.request<HubApiOpResult>('POST', `/boxes/${encodeURIComponent(id)}/git/${op}`, body);
  }

  /**
   * Create a box (async). Forks server-side: a `projectId` with a local workspace
   * → the file queue; a `repoUrl` (or a projectId with no local folder) → the
   * control-plane clone queue. Returns the background job id; progress streams
   * over {@link streamJobLog} and the verdict comes from {@link getJob}.
   */
  async createBox(body: HubApiCreateBoxInput): Promise<{ jobId: string }> {
    return this.request<{ jobId: string }>('POST', '/boxes', body);
  }

  /** Create-job status (poll until done/failed). */
  getJob(id: string): Promise<HubApiJob> {
    return this.request<HubApiJob>('GET', `/jobs/${encodeURIComponent(id)}`);
  }

  /** The unified background-job listing (`queue list` / `hub jobs`). Newest first. */
  async listJobs(): Promise<HubApiJob[]> {
    return (await this.request<{ jobs: HubApiJob[] }>('GET', '/jobs')).jobs;
  }

  /**
   * Deliver a pasted OAuth code to a create job awaiting a Claude re-login (the
   * one interactive create affordance). The worker consumes it from the manifest.
   */
  async submitLoginCode(id: string, code: string): Promise<void> {
    await this.request<{ ok: true }>('POST', `/jobs/${encodeURIComponent(id)}/login-code`, {
      code,
    });
  }

  /**
   * The hub's sandbox providers. `freshness` additionally reports base staleness
   * (`baseStatus`/`baseStaleReason`), which the hub computes by hashing its own
   * build context — the expensive path, so it stays opt-in there too.
   */
  async listProviders(opts: { freshness?: boolean } = {}): Promise<HubApiProvider[]> {
    const q = opts.freshness ? '?freshness=1' : '';
    return (await this.request<{ providers: HubApiProvider[] }>('GET', `/providers${q}`)).providers;
  }

  /** The remote-docker host aliases the hub itself has registered. */
  async listHosts(): Promise<HubApiHost[]> {
    return (await this.request<{ hosts: HubApiHost[] }>('GET', '/hosts')).hosts;
  }

  /**
   * Bake the box image on one of the HUB's remote-docker hosts. Returns a job id
   * that streams over {@link streamJobLog}, exactly like a provider bake.
   */
  async bakeHost(alias: string): Promise<string> {
    const res = await this.request<{ jobId: string }>(
      'POST',
      `/hosts/${encodeURIComponent(alias)}/bake`,
    );
    return res.jobId;
  }

  /**
   * Persist a provider's credentials ON the hub: the hub validates the given
   * canonical fields (e.g. `{ apiKey }`, `{ token, teamId?, projectId? }`) against
   * the cloud, then writes them to its own `~/.agentbox/secrets.env`. Never echoes
   * secret values. A rejected token surfaces as `HubApiError('invalid_request')`.
   */
  async setProviderCredentials(id: string, fields: Record<string, string>): Promise<void> {
    await this.request<{ ok: true }>(
      'POST',
      `/providers/${encodeURIComponent(id)}/credentials`,
      fields,
    );
  }

  /**
   * Bake a provider's base ON the hub. Async: returns the id of a background job
   * whose progress streams over {@link streamJobLog}.
   */
  async prepareProvider(
    id: string,
    body: {
      force?: boolean;
      claudeInstall?: 'native' | 'npm';
      build?: boolean;
      size?: string;
      location?: string;
      name?: string;
    } = {},
  ): Promise<string> {
    const res = await this.request<{ jobId: string }>(
      'POST',
      `/providers/${encodeURIComponent(id)}/prepare`,
      body,
    );
    return res.jobId;
  }

  /**
   * Stream a job's log lines until the server closes the SSE stream.
   *
   * Deliberately NOT routed through `request`: the response is an event stream,
   * not JSON, and consuming it as text would buffer the whole bake (minutes of
   * silence) before printing anything. Resolves when the stream ends; the caller
   * still polls {@link getJob} for the terminal verdict, since a dropped
   * connection must not read as a successful bake.
   */
  async streamJobLog(
    id: string,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/api/v1/jobs/${encodeURIComponent(id)}/logs`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE frames are blank-line separated; a partial trailing frame stays in
      // the buffer until the rest of it arrives.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let event = '';
        let data = '';
        for (const raw of frame.split('\n')) {
          if (raw.startsWith('event:')) event = raw.slice(6).trim();
          else if (raw.startsWith('data:')) data = raw.slice(5).trim();
        }
        // `open`/`end`/`login` carry structured state the caller gets from
        // getJob instead; only the log lines belong on screen.
        if (event !== 'log' || data.length === 0) continue;
        try {
          const line = JSON.parse(data) as unknown;
          if (typeof line === 'string' && line.length > 0) onLine(line);
        } catch {
          /* a frame we can't parse is not worth failing a bake over */
        }
      }
    }
  }

  /** Pending host-action approvals across every box. */
  async listApprovals(): Promise<HubApiApproval[]> {
    return (await this.request<{ approvals: HubApiApproval[] }>('GET', '/approvals')).approvals;
  }

  /**
   * Answer a pending approval by id. `cancelled` marks a dismissal distinctly
   * from a plain deny in the audit trail (the `agent approve --cancel` capability);
   * it still resolves the parked action as not-approved.
   */
  async answerApproval(id: string, answer: 'y' | 'n', cancelled?: boolean): Promise<void> {
    await this.request<{ ok: true }>('POST', `/approvals/${encodeURIComponent(id)}/answer`, {
      answer,
      ...(cancelled === true ? { cancelled: true } : {}),
    });
  }

  /**
   * The box's agentbox.yaml service/task/port status — a live in-box pull when the
   * box is running, else the persisted snapshot (so a paused box still reports),
   * matching what `agentbox status` shows.
   */
  getServices(id: string): Promise<HubApiServices> {
    return this.request<HubApiServices>('GET', `/boxes/${encodeURIComponent(id)}/services`);
  }

  /** Restart one service by name, or every service when `name` is omitted. */
  restartService(id: string, name?: string): Promise<HubApiOpResult> {
    return this.request<HubApiOpResult>(
      'POST',
      `/boxes/${encodeURIComponent(id)}/services/restart`,
      name ? { name } : {},
    );
  }

  /**
   * Set (or clear, with an empty string) a box's cosmetic display label. Pure
   * state — the container / git branch / URL are untouched.
   */
  async rename(id: string, displayName: string): Promise<void> {
    await this.request<{ ok: true }>('POST', `/boxes/${encodeURIComponent(id)}/rename`, {
      displayName,
    });
  }

  // ── checkpoints (durable project assets) ──

  /** Capture the box state as a project checkpoint (docker commit / cloud snapshot). */
  createCheckpoint(
    id: string,
    body: { name?: string; merged?: boolean; setDefault?: boolean; replace?: boolean } = {},
  ): Promise<HubApiCheckpointCreate> {
    return this.request<HubApiCheckpointCreate>(
      'POST',
      `/boxes/${encodeURIComponent(id)}/checkpoint`,
      body,
    );
  }

  /** List a project's checkpoints (docker + cloud), or every project's with `global`. */
  listCheckpoints(
    opts: { project?: string; global?: boolean } = {},
  ): Promise<HubApiCheckpointListing> {
    const q = new URLSearchParams();
    if (opts.global) q.set('global', '1');
    if (opts.project !== undefined) q.set('project', opts.project);
    return this.request<HubApiCheckpointListing>('GET', `/checkpoints?${q.toString()}`);
  }

  /** Delete a checkpoint from every store that has it (or just `provider`'s). */
  deleteCheckpoint(opts: {
    project: string;
    ref: string;
    provider?: string;
  }): Promise<HubApiCheckpointRemove> {
    const q = new URLSearchParams({ project: opts.project, ref: opts.ref });
    if (opts.provider !== undefined) q.set('provider', opts.provider);
    return this.request<HubApiCheckpointRemove>('DELETE', `/checkpoints?${q.toString()}`);
  }

  // ── prune (fleet cleanup) ──

  /**
   * Prune orphan fleet resources. Without `provider` (or provider === 'docker'):
   * orphan docker records/resources + project configs. With a cloud provider:
   * enumerate untracked sandboxes, deleting + reaping when !dryRun.
   */
  prune(
    body: { all?: boolean; dryRun?: boolean; provider?: string } = {},
  ): Promise<HubApiPruneView> {
    return this.request<HubApiPruneView>('POST', '/prune', body);
  }

  // ── agent state ──

  /** The box's in-box coding-agent status snapshot (Claude activity/plan/question). */
  getAgentState(id: string): Promise<HubApiAgentState> {
    return this.request<HubApiAgentState>('GET', `/boxes/${encodeURIComponent(id)}/agent`);
  }

  // ── box service logs ──

  /** Non-follow tail of a service log (or the ctl-daemon log with `daemon`). */
  async getBoxLogs(
    id: string,
    params: { service?: string; tail: number; daemon?: boolean },
  ): Promise<{ output: string }> {
    return this.request<{ output: string }>(
      'GET',
      `/boxes/${encodeURIComponent(id)}/logs?${logQuery(params).toString()}`,
    );
  }

  /**
   * Follow a service log over SSE, invoking `onLine` for each `log` event until the
   * hub closes the stream. Resolves with the terminal status (from the `end` event,
   * or 'gone' if the stream dropped). A non-2xx answer (e.g. box not found) throws
   * a {@link HubApiError} so `withOwningHub` can retry the other hub — mirrors
   * {@link streamJobLog}, which deliberately bypasses `request` for the same reason.
   */
  async streamBoxLog(
    id: string,
    params: { service?: string; tail: number; daemon?: boolean },
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<{ status: string }> {
    const res = await this.fetchImpl(
      `${this.base}/api/v1/boxes/${encodeURIComponent(id)}/logs?${logQuery({ ...params, follow: true }).toString()}`,
      { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal },
    );
    if (!res.ok) {
      // The route answers a bad request / missing box with the JSON error envelope,
      // not an SSE stream — surface it as a HubApiError like `request` does.
      const text = await res.text().catch(() => '');
      let body: ApiErrorBody = {};
      try {
        body = text.length > 0 ? (JSON.parse(text) as ApiErrorBody) : {};
      } catch {
        /* non-JSON error body */
      }
      throw new HubApiError(
        body.error?.message ?? `request failed: ${res.status}`,
        body.error?.code ?? 'internal',
        res.status,
        body.error?.details,
      );
    }
    if (!res.body) return { status: 'gone' };
    const decoder = new TextDecoder();
    let buffer = '';
    let status = 'gone';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          let event = '';
          let data = '';
          for (const raw of frame.split('\n')) {
            if (raw.startsWith('event:')) event = raw.slice(6).trim();
            else if (raw.startsWith('data:')) data = raw.slice(5).trim();
          }
          if (data.length === 0) continue;
          if (event === 'log') {
            try {
              const line = JSON.parse(data) as unknown;
              if (typeof line === 'string') onLine(line);
            } catch {
              /* a frame we can't parse is not worth aborting the stream over */
            }
          } else if (event === 'end') {
            try {
              const parsed = JSON.parse(data) as { status?: string };
              if (typeof parsed.status === 'string') status = parsed.status;
            } catch {
              /* keep the default */
            }
          }
        }
      }
    } catch (err) {
      // A caller-requested abort (Ctrl-C on a `-f` follow) surfaces as an
      // AbortError from the streaming read — that's a clean stop, not a failure,
      // so don't let it bubble to withHubClient's "can't reach the hub" mapper.
      if (signal?.aborted) return { status: 'aborted' };
      throw err;
    }
    return { status };
  }
}

/** Build the shared `/boxes/:id/logs` query string (service/tail/daemon/follow). */
function logQuery(params: {
  service?: string;
  tail: number;
  daemon?: boolean;
  follow?: boolean;
}): URLSearchParams {
  const q = new URLSearchParams();
  q.set('tail', String(params.tail));
  if (params.service !== undefined) q.set('service', params.service);
  if (params.daemon) q.set('daemon', '1');
  if (params.follow) q.set('follow', '1');
  return q;
}
