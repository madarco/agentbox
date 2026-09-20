import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PtyFrameDecoder,
  encodeCtrl,
  encodeInput,
  type PtyCtrl,
  type PtyCtrlFromClient,
} from '@agentbox/core';
import { readPtyMeta, writePtyMeta, type PtySessionMeta } from '@agentbox/sandbox-core';
import { loadPtyBackend } from '../src/pty-backend.js';
import { PtyHostAlreadyRunning, startPtyHost, type PtyHostHandle } from '../src/pty-host.js';

const backend = await loadPtyBackend();
const TOKEN = 'test-token';

/** Short on purpose: a unix socket path is capped at ~104 bytes. */
function shortTmp(): string {
  return mkdtempSync('/tmp/abpty-');
}

interface TestClient {
  socket: Socket;
  out: () => string;
  ctrls: PtyCtrl[];
  send: (message: PtyCtrlFromClient) => void;
  type: (text: string) => void;
  close: () => void;
}

function attach(socketPath: string): TestClient {
  const socket = connect(socketPath);
  const decoder = new PtyFrameDecoder();
  const ctrls: PtyCtrl[] = [];
  let out = '';
  socket.on('error', () => {});
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      if (frame.type === 'data') out += Buffer.from(frame.payload).toString('utf8');
      if (frame.type === 'ctrl') ctrls.push(frame.message);
      if (frame.type === 'exit') ctrls.push({ t: 'error', code: 'bad-frame', message: 'exit' });
    }
  });
  return {
    socket,
    ctrls,
    out: () => out,
    send: (message) => socket.write(encodeCtrl(message)),
    type: (text) => socket.write(encodeInput(new TextEncoder().encode(text))),
    close: () => socket.destroy(),
  };
}

async function hello(
  client: TestClient,
  id: string,
  cols: number,
  rows: number,
  lease = false,
): Promise<void> {
  client.send({
    t: 'hello',
    v: 1,
    token: TOKEN,
    client: { id, kind: 'cli', cols, rows },
    ...(lease ? { lease: { hold: true, ttlMs: 30_000 } } : {}),
    replay: true,
  });
  await waitFor(() => client.ctrls.some((c) => c.t === 'welcome'));
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await delay(25);
  }
  throw new Error('timed out waiting for condition');
}

function spec(dir: string, managerId = 'aaaabbbbccccdddd'): Parameters<typeof startPtyHost>[0] {
  return {
    managerId,
    workspaceId: 'ws-test',
    agent: 'shell',
    cwd: '/tmp',
    shell: '/bin/bash',
    script: 'exec /bin/bash --norc -i',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PS1: '$ ' },
    token: TOKEN,
    runId: 'run-test',
    cols: 80,
    rows: 24,
    pinned: false,
    leaseGraceMs: 300,
    scrollbackBytes: 65536,
    windowSize: 'latest',
    submitDelayMs: 50,
    baseDir: dir,
  };
}

describe.skipIf(!backend)('pty host (real pty)', () => {
  let dir: string;
  let host: PtyHostHandle;

  beforeAll(async () => {
    dir = shortTmp();
    host = await startPtyHost(spec(dir));
  });

  afterAll(async () => {
    await host.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('fans output out to every client and takes input from any of them', async () => {
    const a = attach(host.socketPath);
    await hello(a, 'cli:a', 80, 24);
    a.type('echo one-from-a\r');
    await waitFor(() => a.out().includes('one-from-a'));

    const b = attach(host.socketPath);
    await hello(b, 'cli:b', 80, 24);
    b.type('echo two-from-b\r');
    await waitFor(() => a.out().includes('two-from-b') && b.out().includes('two-from-b'));
    a.close();
    b.close();
  });

  it('replays history to a late client', async () => {
    const late = attach(host.socketPath);
    await hello(late, 'cli:late', 80, 24);
    await waitFor(() => late.ctrls.some((c) => c.t === 'replay-end'));
    expect(late.out()).toContain('one-from-a');
    late.close();
  });

  it('gives the pty to the most recently active client', async () => {
    const a = attach(host.socketPath);
    await hello(a, 'cli:a2', 80, 24);
    const b = attach(host.socketPath);
    await hello(b, 'cli:b2', 100, 30);
    b.send({ t: 'resize', cols: 100, rows: 30 });
    await waitFor(() => a.ctrls.some((c) => c.t === 'size' && c.cols === 100));
    // Past the attach repaint nudge, which toggles the row count for ~50ms and
    // would otherwise be what `stty` happens to report.
    await delay(250);
    a.type('stty size\r');
    await waitFor(() => a.out().includes('30 100'));
    a.close();
    b.close();
  });

  it('injects text and submits it', async () => {
    const a = attach(host.socketPath);
    await hello(a, 'cli:inject', 80, 24);
    a.send({ t: 'inject', text: 'echo injected\nsecond line', submit: true, submitDelayMs: 50 });
    await waitFor(() => a.out().includes('injected second line'));
    a.close();
  });

  it('refuses a bad token and an unversioned peer', async () => {
    const bad = attach(host.socketPath);
    bad.send({
      t: 'hello',
      v: 1,
      token: 'wrong',
      client: { id: 'cli:bad', kind: 'cli', cols: 80, rows: 24 },
    });
    await waitFor(() => bad.ctrls.some((c) => c.t === 'error' && c.code === 'unauthorized'));
    const old = attach(host.socketPath);
    old.send({
      t: 'hello',
      v: 99,
      token: TOKEN,
      client: { id: 'cli:old', kind: 'cli', cols: 80, rows: 24 },
    });
    await waitFor(() => old.ctrls.some((c) => c.t === 'error' && c.code === 'unsupported-version'));
    bad.close();
    old.close();
  });

  it('refuses to steal a live session s socket', async () => {
    await expect(startPtyHost(spec(dir))).rejects.toBeInstanceOf(PtyHostAlreadyRunning);
  });

  it('adopts a stale socket left by a crashed host', async () => {
    const other = shortTmp();
    const stale = spec(other, 'bbbbccccddddeeee');
    const meta: PtySessionMeta = {
      v: 1,
      managerId: stale.managerId,
      workspaceId: stale.workspaceId,
      agent: stale.agent,
      cwd: stale.cwd,
      socket: '',
      pid: 1,
      startedAt: new Date().toISOString(),
      token: TOKEN,
      runId: 'stale',
      cols: 80,
      rows: 24,
      pinned: false,
      leaseGraceMs: 1000,
    };
    await writePtyMeta(meta, other);
    const second = await startPtyHost(stale);
    expect((await readPtyMeta(stale.managerId, other))?.pid).toBe(process.pid);
    await second.stop();
    rmSync(other, { recursive: true, force: true });
  });
});

describe.skipIf(!backend)('pty host lifetime', () => {
  it('reaps a leased session once the holder is gone past the grace window', async () => {
    const dir = shortTmp();
    const host = await startPtyHost(spec(dir, 'ccccddddeeeeffff'));
    const tray = attach(host.socketPath);
    await hello(tray, 'tray:1', 80, 24, true);
    tray.close();
    const code = await Promise.race([host.done, delay(20_000).then(() => 'timeout' as const)]);
    expect(code).not.toBe('timeout');
    expect(await readPtyMeta('ccccddddeeeeffff', dir)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('keeps a pinned session even with no lease holder', async () => {
    const dir = shortTmp();
    const host = await startPtyHost({ ...spec(dir, 'ddddeeeeffff0000'), pinned: true });
    const tray = attach(host.socketPath);
    await hello(tray, 'tray:2', 80, 24, true);
    tray.close();
    const code = await Promise.race([host.done, delay(6_500).then(() => 'still-running' as const)]);
    expect(code).toBe('still-running');
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
