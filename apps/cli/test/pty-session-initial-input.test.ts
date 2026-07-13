import { describe, expect, it, vi } from 'vitest';
import { PtySession } from '../src/dashboard/pty-session.js';
import type { IPtyLike, TerminalCtor } from '../src/pty/pty-backend.js';

/**
 * The dashboard must type a staged attach command the same way the CLI wrapper
 * does: only once the remote shell has spoken, plus a settle.
 *
 * Writing at spawn loses the race — the bytes reach the shell while it's still
 * starting, its line editor hasn't taken over the tty yet, and the trailing
 * newline is swallowed, leaving the command parked on a `>` continuation prompt.
 * The two paths have to agree, or a daytona box that attaches fine from
 * `agentbox claude attach` silently fails to attach from the dashboard.
 */
function harness(initialInput?: string) {
  const writes: string[] = [];
  let emitData: (d: string) => void = () => {};
  const pty: IPtyLike = {
    onData: (cb) => {
      emitData = cb;
    },
    onExit: () => {},
    write: (d) => writes.push(d),
    resize: () => {},
    kill: () => {},
  };
  // @xterm/headless stand-in: we only care about the pty writes.
  const TerminalClass = class {
    write(_d: string, cb?: () => void) {
      cb?.();
    }
    onData() {}
    dispose() {}
    resize() {}
    buffer = { active: { cursorX: 0, cursorY: 0, getLine: () => undefined } };
  } as unknown as TerminalCtor;

  const session = new PtySession(
    () => pty,
    TerminalClass,
    'b1',
    false,
    'claude',
    'ssh',
    ['host'],
    80,
    24,
    () => {},
    () => {},
    undefined,
    undefined,
    initialInput,
  );
  return { writes, session, remoteSays: (d: string) => emitData(d) };
}

describe('PtySession initial input', () => {
  it('does not type at spawn — the remote shell is not at a prompt yet', () => {
    const { writes } = harness('exec bash /tmp/attach.sh\n');
    expect(writes).toEqual([]);
  });

  it('types once the remote shell speaks, after a settle', async () => {
    vi.useFakeTimers();
    try {
      const { writes, remoteSays } = harness('exec bash /tmp/attach.sh\n');
      remoteSays('vscode@sandbox:~$ ');
      expect(writes).toEqual([]); // still settling
      await vi.advanceTimersByTimeAsync(500);
      expect(writes).toEqual(['exec bash /tmp/attach.sh\n']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('types it exactly once, however chatty the remote is', async () => {
    vi.useFakeTimers();
    try {
      const { writes, remoteSays } = harness('run\n');
      remoteSays('a');
      remoteSays('b');
      await vi.advanceTimersByTimeAsync(500);
      remoteSays('c');
      await vi.advanceTimersByTimeAsync(500);
      expect(writes).toEqual(['run\n']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('types anyway on a deadline when the remote never says anything', async () => {
    vi.useFakeTimers();
    try {
      const { writes } = harness('run\n');
      await vi.advanceTimersByTimeAsync(3100);
      expect(writes).toEqual(['run\n']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes nothing when there is no staged command (every other provider)', async () => {
    vi.useFakeTimers();
    try {
      const { writes, remoteSays } = harness(undefined);
      remoteSays('hello');
      await vi.advanceTimersByTimeAsync(5000);
      expect(writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
