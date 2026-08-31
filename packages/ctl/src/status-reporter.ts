import { spawn } from 'node:child_process';
import type { RelayClient } from './relay-client.js';
import { clearAgentSessionPointer, markAgentActive } from './session-pointer.js';
import type { Supervisor } from './supervisor.js';
import { probeAgentSession } from './tmux.js';
import {
  BOX_STATUS_EVENT,
  BOX_STATUS_SCHEMA,
  type AgentActivityState,
  type AgentPlanPayload,
  type AgentQuestionPayload,
  type AgentStatusEntry,
  type AgentStatusMap,
  type BoxStatus,
  type BoxStatusPort,
} from './types.js';
import { legacyAgentStatusFields, type AgentId } from '@agentbox/core';

/** One agent whose tmux session the reporter probes each snapshot. */
export interface WatchedAgentSession {
  agent: AgentId;
  /** tmux session name to probe (`tmux has-session -t <name>`). */
  sessionName: string;
}

/**
 * The list compiled into this binary. Used until (and unless) the host answers
 * `agents.list` with its own — same posture as `WATCHED_CREDENTIALS`: ctl is
 * BAKED into the box image, so its built-in list is frozen at bake time and an
 * agent added later would otherwise never be probed at all.
 */
export const BAKED_AGENT_SESSIONS: readonly WatchedAgentSession[] = [
  { agent: 'claude', sessionName: 'claude' },
  { agent: 'codex', sessionName: 'codex' },
  { agent: 'opencode', sessionName: 'opencode' },
];

interface AgentRuntimeState {
  state: AgentActivityState;
  updatedAt: string | null;
  plan?: AgentPlanPayload;
  question?: AgentQuestionPayload;
  /** Whether the first-activity pointer write has already fired. */
  marked: boolean;
}

export interface StatusReporterOptions {
  supervisor: Supervisor;
  /** The same RelayClient the supervisor already pushes service-state on. */
  relay: RelayClient;
  boxId: string;
  /** Override the probed agent list (tests); defaults to {@link BAKED_AGENT_SESSIONS}. */
  sessions?: readonly WatchedAgentSession[];
  /** Coalesce bursty supervisor 'change' events. Default 300ms. */
  debounceMs?: number;
  /** Liveness heartbeat so the host file stays fresh while idle. Default 15000ms. */
  periodicMs?: number;
}

/**
 * Aggregates the box's runtime status (services, tasks, listening ports, agent
 * activity) and pushes it to the host relay, which persists it to disk so the
 * host CLI can read it even when the box is paused/stopped. The daemon is the
 * single aggregator and the relay the single writer — no second channel, no
 * races.
 *
 * Agents are held in a MAP rather than named fields. The three built-ins used to
 * have a field, a setter and a snapshot branch each, which is why a fourth agent
 * could not report activity at all — it had nowhere to put the value.
 */
export class StatusReporter {
  private readonly supervisor: Supervisor;
  private readonly relay: RelayClient;
  private readonly boxId: string;
  private readonly debounceMs: number;
  private readonly periodicMs: number;
  private sessions: readonly WatchedAgentSession[];
  private readonly agents = new Map<AgentId, AgentRuntimeState>();
  /** Last-seen tmux liveness per agent, for the running->stopped edge. */
  private readonly lastRunning = new Map<AgentId, boolean>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private readonly onChange = (): void => this.schedulePush();

  constructor(opts: StatusReporterOptions) {
    this.supervisor = opts.supervisor;
    this.relay = opts.relay;
    this.boxId = opts.boxId;
    this.sessions = opts.sessions ?? BAKED_AGENT_SESSIONS;
    this.debounceMs = opts.debounceMs ?? 300;
    this.periodicMs = opts.periodicMs ?? 15_000;
  }

  start(): void {
    this.supervisor.on('change', this.onChange);
    this.periodicTimer = setInterval(() => void this.push(), this.periodicMs);
    this.periodicTimer.unref();
    void this.push();
  }

  stop(): void {
    this.supervisor.off('change', this.onChange);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  /**
   * Swap the probed agent list while running — the daemon starts on the BAKED
   * list so activity reporting is never off, then calls this once the host
   * answers `agents.list`. Exactly {@link CredentialsWatcher.setFiles}'s
   * contract, and for the same reason: awaiting the host here would put a
   * network round-trip on the daemon's critical path.
   *
   * Safe mid-flight — the state and liveness maps are keyed by agent id, so a
   * carried-over agent keeps its history and a dropped one just leaves an unread
   * key behind.
   */
  setSessions(sessions: readonly WatchedAgentSession[]): void {
    if (sessions.length === 0) return;
    this.sessions = sessions;
    this.schedulePush();
  }

  /** The agents currently probed; exposed for the daemon's logs and tests. */
  watchedSessions(): readonly WatchedAgentSession[] {
    return this.sessions;
  }

  /**
   * Record an agent's activity. Fed by the agent's own hooks/plugin through
   * `agentbox-ctl <agent>-state`, and by the in-box tmux scrapers.
   *
   * Sticky end-plan/question handling. Two pressures:
   *   1. The pre-tool ExitPlanMode|AskUserQuestion hook races with the catchall
   *      pre-tool hook ('working'). The catchall must not win.
   *   2. AskUserQuestion ALSO triggers a permission-prompt notification
   *      ('waiting'), so the question payload must survive the question ->
   *      waiting hop. Same for end-plan and the post-approval idle/Stop.
   *
   * Semantics:
   *   - 'working' while currently end-plan/question: swallow unless
   *     clearPending is set (post-tool cleanup).
   *   - Any other state: accept, but DON'T auto-clear the plan/question payload
   *     — only clearPending=true clears them, or a fresh pre-tool hook
   *     overwrites with new content.
   */
  setAgentState(
    agent: AgentId,
    state: AgentActivityState,
    payload?: {
      plan?: AgentPlanPayload;
      question?: AgentQuestionPayload;
      clearPending?: boolean;
    },
  ): void {
    const cur = this.agentState(agent);
    const sticky = cur.state === 'end-plan' || cur.state === 'question';
    if (state === 'working' && sticky && !payload?.clearPending) return;

    cur.state = state;
    cur.updatedAt = new Date().toISOString();

    if (payload?.clearPending) {
      cur.plan = undefined;
      cur.question = undefined;
    }
    if (state === 'end-plan' && payload?.plan) cur.plan = payload.plan;
    if (state === 'question' && payload?.question) cur.question = payload.question;

    if (!cur.marked) {
      cur.marked = true;
      // No-op unless this agent has a presence-only pointer.
      markAgentActive(agent);
    }
    this.schedulePush();
  }

  /**
   * Screen-scraper safety net: promote a *stuck* `working` to `waiting` when the
   * agent's tmux pane shows a prompt the hooks missed (MCP tool dialogs have no
   * hook; a permission-prompt notification can fire late or drop).
   * Deliberately promote-ONLY — it acts solely when the current state is
   * `working`, so it never clobbers the richer hook-driven `end-plan`/`question`
   * (sticky) or `idle`/`compacting`/`error`. The next real hook overwrites
   * `waiting`->`working` when the agent resumes, so no demote path is needed.
   * Returns true if it promoted.
   */
  markScreenWaiting(agent: AgentId): boolean {
    const cur = this.agents.get(agent);
    if (!cur || cur.state !== 'working') return false;
    cur.state = 'waiting';
    cur.updatedAt = new Date().toISOString();
    this.schedulePush();
    return true;
  }

  /** Forced immediate push (used on shutdown). */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    void this.push();
  }

  private agentState(agent: AgentId): AgentRuntimeState {
    let cur = this.agents.get(agent);
    if (!cur) {
      cur = { state: 'unknown', updatedAt: null, marked: false };
      this.agents.set(agent, cur);
    }
    return cur;
  }

  private schedulePush(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.push();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private async push(): Promise<void> {
    if (!this.relay.enabled) return;
    try {
      const snapshot = await this.snapshot();
      void this.relay.post(BOX_STATUS_EVENT, snapshot);
    } catch {
      // Best-effort, exactly like the relay client itself — a status push
      // failure must never disturb the supervisor.
    }
  }

  private async snapshot(): Promise<BoxStatus> {
    const probePorts = this.supervisor.serviceProbePorts(); // serviceName -> port
    const probed = this.supervisor.probedServices(); // serviceName (port OR log_match)
    const exposes = this.supervisor.serviceExposes(); // serviceName -> expose
    const services = this.supervisor.list().map((s) => ({
      name: s.name,
      state: s.state,
      port: probePorts.get(s.name) ?? null,
      ...(probed.has(s.name) ? { probed: true } : {}),
      ...(exposes.has(s.name) ? { expose: exposes.get(s.name) } : {}),
    }));
    const tasks = this.supervisor.listTasks().map((t) => ({ name: t.name, state: t.state }));

    const ports = await collectPorts(this.supervisor);
    const agents = await this.agentStatusMap();

    return {
      schema: BOX_STATUS_SCHEMA,
      boxId: this.boxId,
      timestamp: new Date().toISOString(),
      services,
      tasks,
      ports,
      agents,
      // The legacy mirror, DERIVED — see BoxStatus.claude for why it is still
      // written. Never assemble these by hand.
      ...legacyAgentStatusFields(agents),
    };
  }

  /**
   * Probe every watched agent's tmux session and fold it together with the
   * reported activity.
   *
   * An agent is included only when there is something to report — its session is
   * up, or it has reported a state — so a claude-only box's snapshot carries one
   * entry, exactly as the named fields used to be omitted.
   */
  private async agentStatusMap(): Promise<AgentStatusMap> {
    const out: AgentStatusMap = {};
    for (const { agent, sessionName } of this.sessions) {
      const probe = await probeAgentSession(sessionName);

      // Clear the per-box session pointer/marker when an agent's tmux session
      // ends (running -> not running). This keeps a box restart from resuming an
      // agent the user already exited — restore should only bring back what was
      // actually running when the box went down. A fresh daemon starts from
      // `false`, so a just-restored agent (rising edge) is never cleared.
      if (this.lastRunning.get(agent) && !probe.running) {
        clearAgentSessionPointer(agent);
      }
      this.lastRunning.set(agent, probe.running);

      const cur = this.agents.get(agent);
      if (!probe.running && (!cur || cur.state === 'unknown')) continue;

      const entry: AgentStatusEntry = {
        state: cur?.state ?? 'unknown',
        updatedAt: cur?.updatedAt ?? null,
        sessionRunning: probe.running,
        ...(probe.title ? { sessionTitle: probe.title } : {}),
        ...(cur?.plan ? { plan: cur.plan } : {}),
        ...(cur?.question ? { question: cur.question } : {}),
      };
      out[agent] = entry;
    }
    return out;
  }
}

/**
 * Live-discover listening ports and attribute each to the service whose
 * `ready_when.port` probe matches it (else null — an ad-hoc port). Shared by
 * the periodic snapshot pushed to the relay and the on-demand `status` wire op.
 */
export async function collectPorts(supervisor: Supervisor): Promise<BoxStatusPort[]> {
  const probePorts = supervisor.serviceProbePorts(); // serviceName -> port
  const portToService = new Map<number, string>();
  for (const [name, port] of probePorts) {
    if (!portToService.has(port)) portToService.set(port, name);
  }
  return (await discoverListeningPorts()).map((port) => ({
    port,
    service: portToService.get(port) ?? null,
  }));
}

function run(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.on('error', () => resolve({ exitCode: 127, stdout }));
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout }));
  });
}

/**
 * Live-discover listening TCP ports inside the box. `ss -ltnH` (iproute2, in
 * the base image) prints headerless rows whose 4th column is the local
 * `addr:port`; we take the part after the last colon. Falls back to
 * `netstat -ltn` if `ss` is unavailable. Returns a sorted, de-duplicated list.
 */
export async function discoverListeningPorts(): Promise<number[]> {
  let out = await run('ss', ['-ltnH']);
  let localCol = 3; // ss -H rows: State Recv-Q Send-Q Local Peer
  if (out.exitCode !== 0) {
    out = await run('netstat', ['-ltn']);
    localCol = 3; // netstat rows: Proto Recv-Q Send-Q Local Foreign State
    if (out.exitCode !== 0) return [];
  }
  const ports = new Set<number>();
  for (const line of out.stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const local = cols[localCol];
    if (!local) continue;
    const colon = local.lastIndexOf(':');
    if (colon === -1) continue;
    const port = Number.parseInt(local.slice(colon + 1), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
