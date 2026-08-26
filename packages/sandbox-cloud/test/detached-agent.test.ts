import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import { startDetachedCloudAgent } from '../src/detached-agent.js';

// A live, authenticated pane — verifyDetachedSession sees the session and no
// auth-rejection markers, so it resolves.
const HEALTHY: ExecResult = { exitCode: 0, stdout: 'Working on it...', stderr: '' };

// The bare `tmux has-session` probe the retry path uses to decide whether a
// transport failure still left a session behind. Distinguished from the verify
// probe, which also captures the pane.
const isSessionExistsProbe = (argv: string[]): boolean =>
  argv.some((a) => a.includes('has-session') && !a.includes('capture-pane'));

interface FakeOpts {
  state?: 'running' | 'paused' | 'stopped' | 'missing';
  exec?: (argv: string[]) => ExecResult;
  onBuildAttach?: (opts: unknown) => void;
  /** argv runDetached spawns, per attempt (1-indexed); defaults to `true`. */
  argvForAttempt?: (attempt: number) => string[];
}

function fakeProvider(opts: FakeOpts = {}): {
  provider: Provider;
  started: () => number;
  attempts: () => number;
} {
  let starts = 0;
  let attempts = 0;
  const provider = {
    name: 'e2b',
    probeState: () => Promise.resolve(opts.state ?? 'running'),
    start: (box: BoxRecord) => {
      starts++;
      return Promise.resolve(box);
    },
    // `true` is a real no-op binary, so runDetached spawns it → exit 0 without
    // touching a sandbox. The verify step below drives the mocked exec.
    buildAttach: (_box: BoxRecord, _kind: string, o: unknown) => {
      opts.onBuildAttach?.(o);
      attempts++;
      return Promise.resolve({ argv: opts.argvForAttempt?.(attempts) ?? ['true'], env: undefined });
    },
    exec: (_box: BoxRecord, argv: string[]) =>
      Promise.resolve(
        opts.exec?.(argv) ??
          // No session yet unless a test says otherwise; the verify probe is healthy.
          (isSessionExistsProbe(argv) ? { exitCode: 1, stdout: '', stderr: '' } : HEALTHY),
      ),
  } as unknown as Provider;
  return { provider, started: () => starts, attempts: () => attempts };
}

const box = { name: 'kanban', cloud: { sandboxId: 'sbx-1' } } as BoxRecord;

describe('startDetachedCloudAgent', () => {
  it('starts the detached session and verifies it for a running box', async () => {
    const seen: unknown[] = [];
    const { provider, started } = fakeProvider({ onBuildAttach: (o) => seen.push(o) });
    await expect(
      startDetachedCloudAgent({
        provider,
        box,
        binary: 'claude',
        sessionName: 'claude',
        extraArgs: ['do a thing'],
        verify: { windowMs: 0 },
      }),
    ).resolves.toBeDefined();
    expect(started()).toBe(0); // already running → no start
    // buildAttach was asked for a detached session with the seeded command.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionName: 'claude', detached: true });
    expect((seen[0] as { command: string }).command).toContain('exec claude');
  });

  it('starts a paused box before launching', async () => {
    const { provider, started } = fakeProvider({ state: 'paused' });
    await startDetachedCloudAgent({
      provider,
      box,
      binary: 'codex',
      sessionName: 'codex',
      extraArgs: ['x'],
      verify: { windowMs: 0 },
    });
    expect(started()).toBe(1);
  });

  it('throws when the sandbox is missing', async () => {
    const { provider } = fakeProvider({ state: 'missing' });
    await expect(
      startDetachedCloudAgent({
        provider,
        box,
        binary: 'claude',
        sessionName: 'claude',
        extraArgs: ['x'],
      }),
    ).rejects.toThrow(/missing/);
  });

  it('propagates a verify failure when the session did not stay up (exit 7)', async () => {
    const { provider } = fakeProvider({ exec: () => ({ exitCode: 7, stdout: '', stderr: '' }) });
    await expect(
      startDetachedCloudAgent({
        provider,
        box,
        binary: 'claude',
        sessionName: 'claude',
        extraArgs: ['x'],
      }),
    ).rejects.toThrow(/exited immediately after launch/);
  });

  it('surfaces the stderr of a fast-failing start (drains the pipe before resolving)', async () => {
    // Regression: resolving on `exit` instead of `close` raced the buffered
    // stderr, so a sub-second ssh failure reported a bare exit code with no cause.
    const { provider } = fakeProvider({
      argvForAttempt: () => ['bash', '-c', 'echo "closed by remote host" >&2; exit 255'],
    });
    await expect(
      startDetachedCloudAgent({
        provider,
        box,
        binary: 'claude',
        sessionName: 'claude',
        extraArgs: ['x'],
        startRetry: { attempts: 1 },
      }),
    ).rejects.toThrow(/closed by remote host/);
  });

  it('retries a 255 transport failure with a freshly built attach spec', async () => {
    // Daytona's SSH gateway hangs up on an attach token it does not recognise
    // yet — each retry re-runs buildAttach, minting a new one.
    const { provider, attempts } = fakeProvider({
      argvForAttempt: (n) => (n < 3 ? ['bash', '-c', 'exit 255'] : ['true']),
    });
    await expect(
      startDetachedCloudAgent({
        provider,
        box,
        binary: 'claude',
        sessionName: 'claude',
        extraArgs: ['x'],
        verify: { windowMs: 0 },
        startRetry: { attempts: 3, backoffMs: 0 },
      }),
    ).resolves.toBeDefined();
    expect(attempts()).toBe(3);
  });

  it('does not retry a non-transport failure', async () => {
    const { provider, attempts } = fakeProvider({
      argvForAttempt: () => ['bash', '-c', 'echo "duplicate session" >&2; exit 1'],
    });
    await expect(
      startDetachedCloudAgent({
        provider,
        box,
        binary: 'claude',
        sessionName: 'claude',
        extraArgs: ['x'],
        startRetry: { attempts: 3, backoffMs: 0 },
      }),
    ).rejects.toThrow(/duplicate session/);
    expect(attempts()).toBe(1);
  });

  it('accepts a session the failed transport left behind instead of retrying', async () => {
    const { provider, attempts } = fakeProvider({
      argvForAttempt: () => ['bash', '-c', 'exit 255'],
      // The disconnect happened after tmux created the session; a blind retry
      // would fail forever on tmux's duplicate-session error.
      exec: () => HEALTHY,
    });
    await expect(
      startDetachedCloudAgent({
        provider,
        box,
        binary: 'claude',
        sessionName: 'claude',
        extraArgs: ['x'],
        verify: { windowMs: 0 },
        startRetry: { attempts: 3, backoffMs: 0 },
      }),
    ).resolves.toBeDefined();
    expect(attempts()).toBe(1);
  });

  it('resolves resume args only when extraArgs is empty', async () => {
    const resolveResumeArgs = vi.fn().mockResolvedValue(['--resume', 'abc']);
    const seen: unknown[] = [];
    const { provider } = fakeProvider({ onBuildAttach: (o) => seen.push(o) });
    await startDetachedCloudAgent({
      provider,
      box,
      binary: 'claude',
      sessionName: 'claude',
      resolveResumeArgs,
      verify: { windowMs: 0 },
    });
    expect(resolveResumeArgs).toHaveBeenCalledOnce();
    // The resumed args reached the launcher (base64-embedded, so just assert the
    // read-loop launcher form, not the literal flags).
    expect((seen[0] as { command: string }).command).toContain('while IFS= read -r t');
  });
});
