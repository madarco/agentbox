import { mkdtempSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { loadPtyBackend, startPtyHost, type PtyHostHandle } from '@agentbox/cli-kit';
import { attachPtySession } from '../src/manager/pty-attach.js';

const backend = await loadPtyBackend();

/** Short on purpose: a unix socket path is capped at ~104 bytes. */
function shortTmp(): string {
  return mkdtempSync('/tmp/abattach-');
}

function fakeTty(): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  out: () => string;
  err: () => string;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c: Buffer) => {
    out += c.toString('utf8');
  });
  stderr.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  Object.assign(stdout, { columns: 80, rows: 24 });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    out: () => out,
    err: () => err,
  };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await delay(25);
  }
  throw new Error('timed out waiting for condition');
}

function hostSpec(dir: string, managerId: string): Parameters<typeof startPtyHost>[0] {
  return {
    managerId,
    workspaceId: 'ws-attach',
    agent: 'shell',
    cwd: '/tmp',
    shell: '/bin/bash',
    script: 'exec /bin/bash --norc -i',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PS1: '$ ' },
    token: 'attach-token',
    runId: 'run-attach',
    cols: 80,
    rows: 24,
    pinned: true,
    leaseGraceMs: 60_000,
    scrollbackBytes: 65536,
    windowSize: 'latest',
    submitDelayMs: 50,
    baseDir: dir,
  };
}

describe('attachPtySession', () => {
  it('reports a missing session instead of hanging', async () => {
    const dir = shortTmp();
    const result = await attachPtySession({
      managerId: 'ffffffffffffffff',
      baseDir: dir,
      clientId: 'cli:test',
      kind: 'cli',
    });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'no pty session on this machine' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!backend)('attachPtySession (real pty)', () => {
  it('proxies both directions and leaves on the detach chord', async () => {
    const dir = shortTmp();
    const host: PtyHostHandle = await startPtyHost(hostSpec(dir, 'a1a1a1a1a1a1a1a1'));
    const tty = fakeTty();
    const attached = attachPtySession({
      managerId: 'a1a1a1a1a1a1a1a1',
      baseDir: dir,
      clientId: 'cli:test',
      kind: 'cli',
      stdin: tty.stdin,
      stdout: tty.stdout,
      stderr: tty.stderr,
    });
    await waitFor(() => tty.err().includes('to detach'));
    expect(tty.err()).toContain('C-] d');

    tty.stdin.write('echo proxied-round-trip\r');
    await waitFor(() => tty.out().includes('proxied-round-trip'));

    // Ctrl-] d — the one sequence the client interprets.
    tty.stdin.write(Buffer.from([0x1d, 0x64]));
    expect(await attached).toEqual({ outcome: 'detached' });

    // Detaching is not stopping: the session is still there to attach to.
    const second = fakeTty();
    const again = attachPtySession({
      managerId: 'a1a1a1a1a1a1a1a1',
      baseDir: dir,
      clientId: 'cli:test2',
      kind: 'cli',
      raw: true,
      stdin: second.stdin,
      stdout: second.stdout,
      stderr: second.stderr,
    });
    await waitFor(() => second.out().includes('proxied-round-trip'));
    // --raw prints no lead-in: an embedding terminal shows the session alone.
    expect(second.err()).toBe('');
    second.stdin.write(Buffer.from([0x1d, 0x64]));

    await host.stop();
    expect((await again).outcome).toBe('exited');
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('ends with the session when the agent exits', async () => {
    const dir = shortTmp();
    const host = await startPtyHost(hostSpec(dir, 'b2b2b2b2b2b2b2b2'));
    const tty = fakeTty();
    const attached = attachPtySession({
      managerId: 'b2b2b2b2b2b2b2b2',
      baseDir: dir,
      clientId: 'cli:test',
      kind: 'cli',
      stdin: tty.stdin,
      stdout: tty.stdout,
      stderr: tty.stderr,
    });
    await waitFor(() => tty.err().includes('to detach'));
    tty.stdin.write('exit 3\r');
    expect(await attached).toEqual({ outcome: 'exited', code: 3 });
    await host.done;
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
