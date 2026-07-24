import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import { startDetachedCloudAgent } from '../src/detached-agent.js';

// A live, authenticated pane — verifyDetachedSession sees the session and no
// auth-rejection markers, so it resolves.
const HEALTHY: ExecResult = { exitCode: 0, stdout: 'Working on it...', stderr: '' };

interface FakeOpts {
  state?: 'running' | 'paused' | 'stopped' | 'missing';
  exec?: (argv: string[]) => ExecResult;
  onBuildAttach?: (opts: unknown) => void;
}

function fakeProvider(opts: FakeOpts = {}): { provider: Provider; started: () => number } {
  let starts = 0;
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
      return Promise.resolve({ argv: ['true'], env: undefined });
    },
    exec: (_box: BoxRecord, argv: string[]) => Promise.resolve((opts.exec ?? (() => HEALTHY))(argv)),
  } as unknown as Provider;
  return { provider, started: () => starts };
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
      startDetachedCloudAgent({ provider, box, binary: 'claude', sessionName: 'claude', extraArgs: ['x'] }),
    ).rejects.toThrow(/missing/);
  });

  it('propagates a verify failure when the session did not stay up (exit 7)', async () => {
    const { provider } = fakeProvider({ exec: () => ({ exitCode: 7, stdout: '', stderr: '' }) });
    await expect(
      startDetachedCloudAgent({ provider, box, binary: 'claude', sessionName: 'claude', extraArgs: ['x'] }),
    ).rejects.toThrow(/exited immediately after launch/);
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
