import { open, readdir, readFile, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  STATE_DIR,
  listProjectsConfigured,
  loadEffectiveConfig,
  tryGetMachineId,
} from '@agentbox/config';
import {
  HistoryShipper,
  createRedactor,
  hostProjectKey,
  type AgentHistorySpec,
  type HistoryBinding,
  type HistoryFileSource,
  type HistoryFrame,
  type HistoryIngestResult,
  type HistoryIngestSink,
  type Redactor,
} from '@agentbox/core';
import { AGENT_SYNC_SPECS, hubBearerFor, readState } from '@agentbox/sandbox-core';
import { collectHostSecrets } from './host-secrets.js';
import { hostProjectDecisions, type HostProjectDecision } from './host-settings.js';

/**
 * Phase 5 of docs/agent-history-plan.md: ship the agent sessions run directly on
 * this PC (not in a box) to the configured hub.
 *
 * Opt-in. `history.hostSessions` globally is the toggle; a project's own value
 * allows (true) or denies (false) it. Only folders agentbox knows on this PC are
 * read (registered projects + this PC's box records), never the agent's whole
 * transcript tree. The engine is the same `HistoryShipper` the box edges run,
 * over the local disk, with a `host` origin.
 */

/** The watcher's last pass, for `agentbox sessions host` and `GET /api/v1/history/host`. */
export const HOST_SESSIONS_STATUS_FILE = join(STATE_DIR, 'history-host.json');

export interface HostProjectStatus extends HostProjectDecision {
  /** Session files seen / shipped bytes in the last pass (allowed projects only). */
  files?: number;
  bytes?: number;
}

export interface HostSessionsStatus {
  /** The global toggle at the last pass. */
  enabled: boolean;
  /** Where frames go: `local` (this machine's hub), a hub URL, or null (nowhere). */
  target: string | null;
  hostId: string | null;
  lastPassAt: string | null;
  projects: HostProjectStatus[];
  sessions: number;
  bytesShipped: number;
  errors: string[];
}

export interface HostSink {
  /** `local`, or the hub URL. */
  target: string;
  sink: HistoryIngestSink;
}

export interface HostSessionWatcherDeps {
  /** The hub to ship to right now, or a reason there is none. Called every pass. */
  resolveSink(): Promise<HostSink | { target: null; reason: string }>;
  log(line: string): void;
  intervalMs?: number;
  /** Tests: the home dir agent config dirs are under, and the seams below. */
  home?: string;
  statusFile?: string;
  knownFolders?: () => Promise<Array<{ folder: string; originUrl?: string }>>;
  decide?: typeof hostProjectDecisions;
  hostSecrets?: () => Promise<string[]>;
  machineId?: () => string | null;
}

interface WatchedAgent {
  agent: string;
  hostConfigDir: string;
  spec: AgentHistorySpec;
  hostKey: 'dashed-path';
}

/** Agents whose `history.transcripts` declares how a host folder is keyed. */
export function hostWatchedAgents(home: string = homedir()): WatchedAgent[] {
  const out: WatchedAgent[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    const rel = spec.staticPaths[0]?.hostHomeRel;
    if (!spec.history || !rel) continue;
    const transcripts = spec.history.transcripts.filter((t) => t.mode === 'append' && t.hostKey);
    if (transcripts.length === 0) continue;
    out.push({
      agent: spec.id,
      hostConfigDir: join(home, ...rel),
      spec: { transcripts },
      hostKey: transcripts[0]!.hostKey!,
    });
  }
  return out;
}

/** Registered project folders plus this PC's box project roots, deduped. */
export async function knownProjectFolders(): Promise<
  Array<{ folder: string; originUrl?: string }>
> {
  const out = new Map<string, { folder: string; originUrl?: string }>();
  for (const p of await listProjectsConfigured().catch(() => [])) {
    out.set(p.originalPath, {
      folder: p.originalPath,
      ...(p.originUrl ? { originUrl: p.originUrl } : {}),
    });
  }
  try {
    for (const b of (await readState()).boxes) {
      if (b.projectRoot && !out.has(b.projectRoot))
        out.set(b.projectRoot, { folder: b.projectRoot });
    }
  } catch {
    /* no state file */
  }
  return [...out.values()];
}

/**
 * A `HistoryFileSource` over this PC's disk. Its bindings are the session files
 * present in one project dir: every stem there is a host session (no box writes
 * a PC's `~/.claude/projects`), so nothing needs a binding log.
 */
export function localHostSource(agent: string, sessionDir: string): HistoryFileSource {
  return {
    async readBindings(): Promise<HistoryBinding[]> {
      const names = await readdir(sessionDir).catch(() => [] as string[]);
      return names
        .filter((n) => n.endsWith('.jsonl'))
        .sort()
        .map((n) => ({ ts: '', agent, sessionId: n.slice(0, -'.jsonl'.length) }));
    },
    async size(path) {
      const s = await stat(path).catch(() => null);
      return s && s.isFile() ? s.size : null;
    },
    async read(path, offset, length) {
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    async list(dir) {
      return readdir(dir).catch(() => null);
    },
  };
}

/** `POST <hub>/api/v1/history/chunks` with a Bearer, for a PC whose hub is elsewhere. */
export function httpHistorySink(hubUrl: string, bearer: () => string): HistoryIngestSink {
  const url = `${hubUrl.replace(/\/+$/, '')}/api/v1/history/chunks`;
  return {
    async ingest(frame: HistoryFrame): Promise<HistoryIngestResult> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer()}` },
        body: JSON.stringify(frame),
        signal: AbortSignal.timeout(60_000),
      });
      // `/api/v1` answers the result itself on 200 and `{error}` otherwise.
      const body = (await res.json().catch(() => null)) as
        | (HistoryIngestResult & { error?: { message?: string } })
        | null;
      if (res.ok && body && typeof body.ok === 'boolean') return body;
      const msg = body?.error?.message ?? `HTTP ${String(res.status)}`;
      // 401/403: not this PC's to write (or not enrolled). Not a transient error.
      return { ok: false, code: 'unavailable', message: `${url}: ${msg}` };
    },
  };
}

/**
 * The sink a PC relay uses: the control box when one is configured and this
 * process is not it, else the hub this relay runs in, else none.
 */
export function defaultHostSinkResolver(opts: {
  controlPlaneUrl: string;
  isControlBox: boolean;
  local?: HistoryIngestSink;
}): () => Promise<HostSink | { target: null; reason: string }> {
  return async () => {
    let url = opts.controlPlaneUrl;
    if (!url && !opts.isControlBox) {
      const c = await loadEffectiveConfig(homedir()).catch(() => null);
      url = (c?.effective.relay.controlPlaneUrl ?? '').trim().replace(/\/+$/, '');
    }
    if (url && !opts.isControlBox) {
      const bearer = hubBearerFor(url, 'api', { configuredUrl: url });
      if (!bearer) {
        return { target: null, reason: `no credential for ${url} (run \`agentbox hub login\`)` };
      }
      // Resolved per request: the shipper (and its sink) outlives this pass,
      // and a re-login replaces the device token.
      const target = url;
      return {
        target,
        sink: httpHistorySink(target, () => hubBearerFor(target, 'api', { configuredUrl: target })),
      };
    }
    if (opts.local) return { target: 'local', sink: opts.local };
    return { target: null, reason: 'this relay runs without a hub and no control box is set' };
  };
}

export class HostSessionWatcher {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private ticking: Promise<HostSessionsStatus> | null = null;
  /** Keyed by `<target>\0<agent>\0<folder>`: a new target starts fresh cursors. */
  private readonly shippers = new Map<string, HistoryShipper>();
  private redactor: Redactor = createRedactor();
  private redactorAt = 0;
  private readonly home: string;
  private readonly statusFile: string;

  constructor(private readonly deps: HostSessionWatcherDeps) {
    this.home = deps.home ?? homedir();
    this.statusFile = deps.statusFile ?? HOST_SESSIONS_STATUS_FILE;
  }

  start(): void {
    const every = this.deps.intervalMs ?? 60_000;
    // First pass soon after boot, then on the interval.
    this.first = setTimeout(() => void this.tick(), Math.min(every, 15_000));
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** One pass. Never overlaps itself; never throws. */
  tick(): Promise<HostSessionsStatus> {
    if (this.ticking) return this.ticking;
    this.ticking = this.pass()
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.log(`history-host: ${msg}`);
        return this.emptyStatus(false, null, [msg]);
      })
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private emptyStatus(
    enabled: boolean,
    target: string | null,
    errors: string[],
  ): HostSessionsStatus {
    return {
      enabled,
      target,
      hostId: (this.deps.machineId ?? tryGetMachineId)() ?? null,
      lastPassAt: new Date().toISOString(),
      projects: [],
      sessions: 0,
      bytesShipped: 0,
      errors,
    };
  }

  private async pass(): Promise<HostSessionsStatus> {
    const folders = await (this.deps.knownFolders ?? knownProjectFolders)();
    const decided = await (this.deps.decide ?? hostProjectDecisions)(folders);
    const projects: HostProjectStatus[] = decided.projects.map((d) => ({ ...d }));
    const status = this.emptyStatus(decided.enabled, null, []);
    status.projects = projects;
    const allowed = projects.filter((p) => p.allowed);
    if (allowed.length === 0) {
      await this.writeStatus(status);
      return status;
    }
    const resolved = await this.deps.resolveSink();
    if (resolved.target === null) {
      status.errors.push(resolved.reason);
      await this.writeStatus(status);
      return status;
    }
    status.target = resolved.target;
    const hostId = status.hostId;
    if (!hostId) {
      status.errors.push('this machine has no machine id');
      await this.writeStatus(status);
      return status;
    }
    await this.refreshRedactor();
    const agents = hostWatchedAgents(this.home);
    const live = new Set<string>();
    for (const p of allowed) {
      const repoUrl = p.repoUrl ?? (await originOf(p.folder));
      if (repoUrl) p.repoUrl = repoUrl;
      p.files = 0;
      p.bytes = 0;
      for (const a of agents) {
        const projectKey = hostProjectKey(a.hostKey, p.folder);
        const key = `${resolved.target}\0${a.agent}\0${p.folder}`;
        live.add(key);
        let shipper = this.shippers.get(key);
        if (!shipper) {
          const root = a.spec.transcripts[0]!.root.replace(/<projectKey>/g, projectKey);
          shipper = new HistoryShipper({
            origin: {
              kind: 'host',
              boxId: '',
              provider: 'host',
              hostId,
              ...(repoUrl ? { projectRepoUrl: repoUrl } : {}),
            },
            agents: [{ agent: a.agent, configDir: a.hostConfigDir, projectKey, spec: a.spec }],
            source: localHostSource(a.agent, join(a.hostConfigDir, root)),
            sink: resolved.sink,
            redactor: { redact: (b) => this.redactor.redact(b) },
            // Under the hub route's 12 MB body cap once base64'd.
            frameMax: resolved.target === 'local' ? 4 * 1024 * 1024 : 2 * 1024 * 1024,
          });
          this.shippers.set(key, shipper);
        }
        const st = await shipper.pass();
        p.files += st.files;
        p.bytes += st.bytes;
        status.bytesShipped += st.bytes;
        status.errors.push(...st.errors.slice(0, 5));
        if (st.disabled) status.errors.push(`${p.folder}: the hub refused (disabled)`);
        const root = join(
          a.hostConfigDir,
          a.spec.transcripts[0]!.root.replace(/<projectKey>/g, projectKey),
        );
        status.sessions += (await readdir(root).catch(() => [] as string[])).filter((n) =>
          n.endsWith('.jsonl'),
        ).length;
      }
      if (p.bytes > 0) {
        this.deps.log(`history-host: ${p.folder} shipped ${String(p.bytes)} byte(s)`);
      }
    }
    for (const k of this.shippers.keys()) if (!live.has(k)) this.shippers.delete(k);
    if (status.errors.length > 0) {
      this.deps.log(`history-host: errors: ${status.errors.slice(0, 3).join('; ')}`);
    }
    await this.writeStatus(status);
    return status;
  }

  private async refreshRedactor(): Promise<void> {
    if (Date.now() - this.redactorAt < 5 * 60_000) return;
    const secrets = await (this.deps.hostSecrets ?? collectHostSecrets)().catch(() => []);
    this.redactor = createRedactor({ secrets });
    this.redactorAt = Date.now();
  }

  private async writeStatus(status: HostSessionsStatus): Promise<void> {
    try {
      await mkdir(dirname(this.statusFile), { recursive: true });
      const tmp = `${this.statusFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.statusFile);
    } catch (e) {
      this.deps.log(`history-host: status file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The watcher's last written status, or null when it never ran here. */
export async function readHostSessionsStatus(
  file: string = HOST_SESSIONS_STATUS_FILE,
): Promise<HostSessionsStatus | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as HostSessionsStatus;
  } catch {
    return null;
  }
}

async function originOf(folder: string): Promise<string | undefined> {
  // `.git/config` read directly: no git process per project per pass.
  try {
    const cfg = await readFile(join(folder, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
    return m?.[1];
  } catch {
    return undefined;
  }
}
