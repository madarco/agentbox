import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { StatusReporter } from '../src/status-reporter.js';
import type { ClaudePlanPayload, ClaudeQuestionPayload } from '../src/types.js';

// The reporter snapshots itself by probing tmux + listing supervisor services.
// We don't want either side-effect in unit tests, so we fake the supervisor
// surface to a no-op and look at `setClaudeState`'s effect on internal state
// indirectly: by reading what gets posted to a stub RelayClient.

interface Posted {
  type: string;
  payload: unknown;
}

interface StubSupervisor extends EventEmitter {
  list(): never[];
  listTasks(): never[];
  serviceProbePorts(): Map<string, number>;
  serviceExposes(): Map<string, { port: number; as: number }>;
}

function stubSupervisor(): StubSupervisor {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    list: (): never[] => [],
    listTasks: (): never[] => [],
    serviceProbePorts: (): Map<string, number> => new Map(),
    serviceExposes: (): Map<string, { port: number; as: number }> => new Map(),
  }) as StubSupervisor;
}

function stubRelay(): { enabled: boolean; post: (type: string, payload: unknown) => void; posted: Posted[] } {
  const posted: Posted[] = [];
  return {
    enabled: true,
    post: (type, payload) => posted.push({ type, payload }),
    posted,
  };
}

async function flushDebounce(reporter: StatusReporter): Promise<void> {
  // The reporter debounces pushes 300ms by default. Force-flush the buffer
  // and wait long enough for the snapshot's async tmux probes to resolve
  // (probeAgentSession spawns `tmux has-session`, which in a unit-test
  // environment fails fast and emits the snapshot with `sessionRunning: false`).
  reporter.flush();
  await new Promise((r) => setTimeout(r, 50));
}

interface PaylClaude {
  state: string;
  plan?: ClaudePlanPayload;
  question?: ClaudeQuestionPayload;
}

function latestClaude(posted: Posted[]): PaylClaude | undefined {
  for (let i = posted.length - 1; i >= 0; i -= 1) {
    const p = posted[i]!;
    if (p.type !== 'box-status') continue;
    const claude = (p.payload as { claude?: PaylClaude } | undefined)?.claude;
    if (claude) return claude;
  }
  return undefined;
}

describe('StatusReporter.setClaudeState (sticky end-plan / question)', () => {
  function makeReporter(): { reporter: StatusReporter; relay: ReturnType<typeof stubRelay> } {
    const sup = stubSupervisor();
    const relay = stubRelay();
    type ReporterOpts = ConstructorParameters<typeof StatusReporter>[0];
    const reporter = new StatusReporter({
      supervisor: sup as unknown as ReporterOpts['supervisor'],
      relay: relay as unknown as ReporterOpts['relay'],
      boxId: 'b1',
      sessionName: 'claude',
      debounceMs: 0,
      periodicMs: 60_000,
    });
    return { reporter, relay };
  }

  it("ignores a 'working' transition while in end-plan unless clearPending is set", async () => {
    const { reporter, relay } = makeReporter();
    const plan: ClaudePlanPayload = { plan: 'do X', capturedAt: '2026-05-27T00:00:00.000Z' };

    reporter.setClaudeState('end-plan', { plan });
    await flushDebounce(reporter);

    // Racing catchall PreToolUse: working (no clear). Should be ignored.
    reporter.setClaudeState('working');
    await flushDebounce(reporter);

    expect(latestClaude(relay.posted)?.state).toBe('end-plan');
    expect(latestClaude(relay.posted)?.plan).toEqual(plan);
  });

  it("clears end-plan when PostToolUse sends 'working --clear-pending'", async () => {
    const { reporter, relay } = makeReporter();
    const plan: ClaudePlanPayload = { plan: 'do X', capturedAt: '2026-05-27T00:00:00.000Z' };

    reporter.setClaudeState('end-plan', { plan });
    reporter.setClaudeState('working', { clearPending: true });
    await flushDebounce(reporter);

    const c = latestClaude(relay.posted);
    expect(c?.state).toBe('working');
    expect(c?.plan).toBeUndefined();
  });

  it("ignores 'working' while in question state unless cleared", async () => {
    const { reporter, relay } = makeReporter();
    const question: ClaudeQuestionPayload = {
      questions: [{ question: 'pick', options: [{ label: 'a' }] }],
      capturedAt: '2026-05-27T00:00:00.000Z',
    };

    reporter.setClaudeState('question', { question });
    reporter.setClaudeState('working');
    await flushDebounce(reporter);

    expect(latestClaude(relay.posted)?.state).toBe('question');
    expect(latestClaude(relay.posted)?.question).toEqual(question);
  });

  it('allows non-working transitions out of end-plan (idle from Stop hook), but keeps the plan payload', async () => {
    const { reporter, relay } = makeReporter();
    const plan: ClaudePlanPayload = { plan: 'do X', capturedAt: '2026-05-27T00:00:00.000Z' };

    reporter.setClaudeState('end-plan', { plan });
    reporter.setClaudeState('idle');
    await flushDebounce(reporter);

    expect(latestClaude(relay.posted)?.state).toBe('idle');
    // Plan is the user's pending decision — it must survive until clearPending.
    expect(latestClaude(relay.posted)?.plan).toEqual(plan);
  });

  it('keeps the question payload through the question → waiting Notification race', async () => {
    const { reporter, relay } = makeReporter();
    const question: ClaudeQuestionPayload = {
      questions: [{ question: 'pick', options: [{ label: 'a' }] }],
      capturedAt: '2026-05-27T00:00:00.000Z',
    };

    reporter.setClaudeState('question', { question });
    // AskUserQuestion also fires Notification:permission_prompt -> 'waiting'.
    // The question payload must persist so `agent get-plan-question` works
    // while Claude is parked at the picker.
    reporter.setClaudeState('waiting');
    await flushDebounce(reporter);

    expect(latestClaude(relay.posted)?.state).toBe('waiting');
    expect(latestClaude(relay.posted)?.question).toEqual(question);
  });

  it('overwrites end-plan with a fresh end-plan payload (re-fires)', async () => {
    const { reporter, relay } = makeReporter();
    const planA: ClaudePlanPayload = { plan: 'A', capturedAt: '2026-05-27T00:00:00.000Z' };
    const planB: ClaudePlanPayload = { plan: 'B', capturedAt: '2026-05-27T00:00:01.000Z' };

    reporter.setClaudeState('end-plan', { plan: planA });
    reporter.setClaudeState('end-plan', { plan: planB });
    await flushDebounce(reporter);

    expect(latestClaude(relay.posted)?.plan).toEqual(planB);
  });
});
