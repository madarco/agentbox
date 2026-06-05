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
  probedServices(): Set<string>;
  serviceExposes(): Map<string, { port: number; as: number }>;
}

function stubSupervisor(): StubSupervisor {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    list: (): never[] => [],
    listTasks: (): never[] => [],
    serviceProbePorts: (): Map<string, number> => new Map(),
    probedServices: (): Set<string> => new Set(),
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

/**
 * Force the reporter to push at least one new snapshot, then wait until it
 * actually lands on the relay stub. `reporter.push()` is fire-and-forget AND
 * its snapshot awaits three `probeAgentSession` calls (each spawns `tmux
 * has-session`). On slow CI runners with no tmux installed, ENOENT can take
 * 100ms+ to surface, so a fixed sleep is fragile — poll instead.
 */
async function flushDebounce(
  reporter: StatusReporter,
  relay: { posted: Posted[] },
): Promise<void> {
  const before = relay.posted.length;
  reporter.flush();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (relay.posted.length > before) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`flushDebounce: no new relay post within 2s (had ${String(before)} before)`);
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
    await flushDebounce(reporter, relay);

    // Racing catchall PreToolUse: working (no clear). Should be ignored.
    reporter.setClaudeState('working');
    await flushDebounce(reporter, relay);

    expect(latestClaude(relay.posted)?.state).toBe('end-plan');
    expect(latestClaude(relay.posted)?.plan).toEqual(plan);
  });

  it("clears end-plan when PostToolUse sends 'working --clear-pending'", async () => {
    const { reporter, relay } = makeReporter();
    const plan: ClaudePlanPayload = { plan: 'do X', capturedAt: '2026-05-27T00:00:00.000Z' };

    reporter.setClaudeState('end-plan', { plan });
    reporter.setClaudeState('working', { clearPending: true });
    await flushDebounce(reporter, relay);

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
    await flushDebounce(reporter, relay);

    expect(latestClaude(relay.posted)?.state).toBe('question');
    expect(latestClaude(relay.posted)?.question).toEqual(question);
  });

  it('allows non-working transitions out of end-plan (idle from Stop hook), but keeps the plan payload', async () => {
    const { reporter, relay } = makeReporter();
    const plan: ClaudePlanPayload = { plan: 'do X', capturedAt: '2026-05-27T00:00:00.000Z' };

    reporter.setClaudeState('end-plan', { plan });
    reporter.setClaudeState('idle');
    await flushDebounce(reporter, relay);

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
    await flushDebounce(reporter, relay);

    expect(latestClaude(relay.posted)?.state).toBe('waiting');
    expect(latestClaude(relay.posted)?.question).toEqual(question);
  });

  it('overwrites end-plan with a fresh end-plan payload (re-fires)', async () => {
    const { reporter, relay } = makeReporter();
    const planA: ClaudePlanPayload = { plan: 'A', capturedAt: '2026-05-27T00:00:00.000Z' };
    const planB: ClaudePlanPayload = { plan: 'B', capturedAt: '2026-05-27T00:00:01.000Z' };

    reporter.setClaudeState('end-plan', { plan: planA });
    reporter.setClaudeState('end-plan', { plan: planB });
    await flushDebounce(reporter, relay);

    expect(latestClaude(relay.posted)?.plan).toEqual(planB);
  });

  it("PreCompact sets 'compacting'; PostCompact (with clearPending) resets to working and clears any pending plan", async () => {
    const { reporter, relay } = makeReporter();
    const plan: ClaudePlanPayload = { plan: 'do X', capturedAt: '2026-05-27T00:00:00.000Z' };

    // Compaction can run while a plan is pending — exercise both transitions.
    reporter.setClaudeState('end-plan', { plan });
    reporter.setClaudeState('compacting');
    await flushDebounce(reporter, relay);
    expect(latestClaude(relay.posted)?.state).toBe('compacting');
    // Plan survives a non-`working` transition (same rule as idle / waiting).
    expect(latestClaude(relay.posted)?.plan).toEqual(plan);

    reporter.setClaudeState('working', { clearPending: true });
    await flushDebounce(reporter, relay);
    expect(latestClaude(relay.posted)?.state).toBe('working');
    expect(latestClaude(relay.posted)?.plan).toBeUndefined();
  });

  it("StopFailure sets 'error'; next UserPromptSubmit naturally clears it back to working", async () => {
    const { reporter, relay } = makeReporter();

    reporter.setClaudeState('error');
    await flushDebounce(reporter, relay);
    expect(latestClaude(relay.posted)?.state).toBe('error');

    // No clearPending needed — error is not sticky.
    reporter.setClaudeState('working');
    await flushDebounce(reporter, relay);
    expect(latestClaude(relay.posted)?.state).toBe('working');
  });

  it('Subagent hooks keep state at working (sanity — they explicitly re-assert working)', async () => {
    const { reporter, relay } = makeReporter();

    reporter.setClaudeState('working');
    reporter.setClaudeState('working'); // SubagentStart hook re-fires working
    reporter.setClaudeState('working'); // SubagentStop hook re-fires working
    await flushDebounce(reporter, relay);
    expect(latestClaude(relay.posted)?.state).toBe('working');
  });
});

describe('StatusReporter.markScreenWaiting (promote-only safety net)', () => {
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

  it('promotes a stuck working -> waiting (and is then a no-op)', async () => {
    const { reporter, relay } = makeReporter();
    reporter.setClaudeState('working');
    expect(reporter.markScreenWaiting()).toBe(true);
    await flushDebounce(reporter, relay);
    expect(latestClaude(relay.posted)?.state).toBe('waiting');
    // Already promoted — a second call doesn't re-fire (state is no longer working).
    expect(reporter.markScreenWaiting()).toBe(false);
  });

  it('never clobbers a richer or non-working hook state', () => {
    for (const setup of [
      (r: StatusReporter) =>
        r.setClaudeState('end-plan', { plan: { plan: 'X', capturedAt: '2026-05-27T00:00:00.000Z' } }),
      (r: StatusReporter) =>
        r.setClaudeState('question', {
          question: { questions: [{ question: 'q', options: [{ label: 'a' }] }], capturedAt: '2026-05-27T00:00:00.000Z' },
        }),
      (r: StatusReporter) => r.setClaudeState('idle'),
      (r: StatusReporter) => r.setClaudeState('compacting'),
      (r: StatusReporter) => r.setClaudeState('error'),
    ]) {
      const { reporter } = makeReporter();
      setup(reporter);
      expect(reporter.markScreenWaiting()).toBe(false);
    }
  });

  it('is a no-op from the initial unknown state', () => {
    const { reporter } = makeReporter();
    expect(reporter.markScreenWaiting()).toBe(false);
  });
});
