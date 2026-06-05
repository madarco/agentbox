import { spawn } from 'node:child_process';
import type { RelayClient } from './relay-client.js';
import type { Supervisor } from './supervisor.js';
import { probeAgentSession } from './tmux.js';
import {
  BOX_STATUS_EVENT,
  BOX_STATUS_SCHEMA,
  DEFAULT_CODEX_SESSION_NAME,
  DEFAULT_OPENCODE_SESSION_NAME,
  type AgentActivityState,
  type BoxStatus,
  type BoxStatusPort,
  type ClaudeActivityState,
  type ClaudePlanPayload,
  type ClaudeQuestionPayload,
} from './types.js';

export interface StatusReporterOptions {
  supervisor: Supervisor;
  /** The same RelayClient the supervisor already pushes service-state on. */
  relay: RelayClient;
  boxId: string;
  sessionName: string;
  /** Coalesce bursty supervisor 'change' events. Default 300ms. */
  debounceMs?: number;
  /** Liveness heartbeat so the host file stays fresh while idle. Default 15000ms. */
  periodicMs?: number;
}

/**
 * Aggregates the box's runtime status (services, tasks, listening ports, claude
 * activity) and pushes it to the host relay, which persists it to disk so the
 * host CLI can read it even when the box is paused/stopped. The daemon is the
 * single aggregator and the relay the single writer — no second channel, no
 * races.
 */
export class StatusReporter {
  private readonly supervisor: Supervisor;
  private readonly relay: RelayClient;
  private readonly boxId: string;
  private readonly sessionName: string;
  private readonly debounceMs: number;
  private readonly periodicMs: number;
  private claudeState: ClaudeActivityState = 'unknown';
  private claudeUpdatedAt: string | null = null;
  private claudePlan: ClaudePlanPayload | undefined;
  private claudeQuestion: ClaudeQuestionPayload | undefined;
  private codexState: AgentActivityState = 'unknown';
  private codexUpdatedAt: string | null = null;
  private opencodeState: AgentActivityState = 'unknown';
  private opencodeUpdatedAt: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private readonly onChange = (): void => this.schedulePush();

  constructor(opts: StatusReporterOptions) {
    this.supervisor = opts.supervisor;
    this.relay = opts.relay;
    this.boxId = opts.boxId;
    this.sessionName = opts.sessionName;
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

  setClaudeState(
    state: ClaudeActivityState,
    payload?: {
      plan?: ClaudePlanPayload;
      question?: ClaudeQuestionPayload;
      clearPending?: boolean;
    },
  ): void {
    // Sticky end-plan/question handling. Two pressures:
    //   1. PreToolUse:ExitPlanMode|AskUserQuestion races with the catchall
    //      PreToolUse:* hook ('working'). The catchall must not win.
    //   2. AskUserQuestion *also* triggers Notification:permission_prompt
    //      ('waiting'), so the question payload must survive the question →
    //      waiting hop. Same for end-plan and the post-approval idle/Stop.
    //
    // Semantics:
    //   - 'working' while currently end-plan/question: swallow unless
    //     clearPending is set (PostToolUse cleanup).
    //   - Any other state: accept, but DON'T auto-clear the plan/question
    //     payload — only clearPending=true clears them, or a fresh PreToolUse
    //     overwrites with new content.
    const sticky = this.claudeState === 'end-plan' || this.claudeState === 'question';
    if (state === 'working' && sticky && !payload?.clearPending) return;

    this.claudeState = state;
    this.claudeUpdatedAt = new Date().toISOString();

    if (payload?.clearPending) {
      this.claudePlan = undefined;
      this.claudeQuestion = undefined;
    }
    if (state === 'end-plan' && payload?.plan) {
      this.claudePlan = payload.plan;
    }
    if (state === 'question' && payload?.question) {
      this.claudeQuestion = payload.question;
    }
    this.schedulePush();
  }

  /**
   * Screen-scraper safety net: promote a *stuck* `working` to `waiting` when the
   * Claude tmux pane shows a prompt the hooks missed (MCP tool dialogs have no
   * hook; the `Notification:permission_prompt` hook can fire late or drop).
   * Deliberately promote-ONLY — it acts solely when the current state is
   * `working`, so it never clobbers the richer hook-driven `end-plan`/`question`
   * (sticky) or `idle`/`compacting`/`error`. The next real hook
   * (`UserPromptSubmit`/`PreToolUse`) overwrites `waiting`→`working` when the
   * agent resumes, so no demote path is needed. Returns true if it promoted.
   */
  markScreenWaiting(): boolean {
    if (this.claudeState !== 'working') return false;
    this.claudeState = 'waiting';
    this.claudeUpdatedAt = new Date().toISOString();
    this.schedulePush();
    return true;
  }

  setCodexState(state: AgentActivityState): void {
    this.codexState = state;
    this.codexUpdatedAt = new Date().toISOString();
    this.schedulePush();
  }

  setOpencodeState(state: AgentActivityState): void {
    this.opencodeState = state;
    this.opencodeUpdatedAt = new Date().toISOString();
    this.schedulePush();
  }

  /** Forced immediate push (used on shutdown). */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    void this.push();
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
      this.relay.post(BOX_STATUS_EVENT, snapshot);
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

    // Probe all three agent tmux sessions — whichever exist get reported.
    const claudeSession = await probeAgentSession(this.sessionName);
    const codexSession = await probeAgentSession(DEFAULT_CODEX_SESSION_NAME);
    const opencodeSession = await probeAgentSession(DEFAULT_OPENCODE_SESSION_NAME);

    const status: BoxStatus = {
      schema: BOX_STATUS_SCHEMA,
      boxId: this.boxId,
      timestamp: new Date().toISOString(),
      services,
      tasks,
      ports,
      claude: {
        state: this.claudeState,
        updatedAt: this.claudeUpdatedAt,
        sessionRunning: claudeSession.running,
        ...(claudeSession.title ? { sessionTitle: claudeSession.title } : {}),
        ...(this.claudePlan ? { plan: this.claudePlan } : {}),
        ...(this.claudeQuestion ? { question: this.claudeQuestion } : {}),
      },
    };
    // Codex / OpenCode bodies are additive and present only when there's
    // something to report — so a claude-only box's snapshot omits them.
    if (codexSession.running || this.codexState !== 'unknown') {
      status.codex = {
        state: this.codexState,
        updatedAt: this.codexUpdatedAt,
        sessionRunning: codexSession.running,
        ...(codexSession.title ? { sessionTitle: codexSession.title } : {}),
      };
    }
    if (opencodeSession.running || this.opencodeState !== 'unknown') {
      status.opencode = {
        state: this.opencodeState,
        updatedAt: this.opencodeUpdatedAt,
        sessionRunning: opencodeSession.running,
        ...(opencodeSession.title ? { sessionTitle: opencodeSession.title } : {}),
      };
    }
    return status;
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
