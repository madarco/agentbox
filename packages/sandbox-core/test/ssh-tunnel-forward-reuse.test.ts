import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshTunnelManager } from '../src/ssh-tunnel.js';

const run = promisify(execFile);

/**
 * The forward map has to survive the PROCESS, not just the manager.
 *
 * A ControlMaster outlives any one `agentbox` invocation, so an in-memory cache
 * made `forward()` idempotent only within a process: every command that resolved
 * a preview URL minted another `-O forward` on the same master, and nothing
 * reaped them. One box had seven.
 *
 * These tests drive a FAKE `ssh` on PATH — the manager shells out, so a stub
 * binary is the seam, and no real SSH or network is involved.
 */
let dir: string;
let listener: Server | undefined;
let realHome: string | undefined;
let realPath: string | undefined;

/**
 * A stub `ssh` on PATH. The manager shells out, so this is the seam:
 *  - `-O check`   -> `Master running (pid=N)` on stderr, exit 0
 *  - `-O forward` -> logged, exit 0
 *  - `-M`         -> creates the control-socket file `open()` checks for
 */
async function installFakeSsh(pid: number): Promise<void> {
  const bin = join(dir, 'ssh');
  const log = join(dir, 'forward.log');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const sock = a[a.indexOf('-S') + 1];
if (a.includes('check')) { process.stderr.write('Master running (pid=${String(pid)})\\n'); process.exit(0); }
if (a.includes('forward')) { fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n'); process.exit(0); }
if (a.includes('-M') && sock) { fs.writeFileSync(sock, ''); }
process.exit(0);
`,
    { mode: 0o755 },
  );
}

async function forwardCount(): Promise<number> {
  try {
    const log = await readFile(join(dir, 'forward.log'), 'utf8');
    return log.split('\n').filter((l) => l.includes('forward')).length;
  } catch {
    return 0;
  }
}

/** A live listener on the local port, so the adopt path's liveness probe passes. */
async function listenOn(port: number): Promise<void> {
  listener = createServer();
  await new Promise<void>((res) => listener!.listen(port, '127.0.0.1', res));
}

/** A manager whose control socket is a path we control — one per "process". */
function newManager(): SshTunnelManager {
  return new SshTunnelManager();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentbox-tunnel-'));
  // `controlSockPath` resolves through `homedir()`, so without this the tests
  // write control sockets and forward maps into the developer's REAL
  // ~/.agentbox/cm. Isolate HOME, not just the box dir.
  realHome = process.env['HOME'];
  realPath = process.env['PATH'];
  process.env['HOME'] = dir;
  process.env['PATH'] = `${dir}:${realPath ?? ''}`;
  await installFakeSsh(4242);
});

afterEach(async () => {
  await new Promise<void>((res) => (listener ? listener.close(() => res()) : res()));
  listener = undefined;
  if (realHome !== undefined) process.env['HOME'] = realHome;
  if (realPath !== undefined) process.env['PATH'] = realPath;
});

describe('forward() reuse', () => {
  it('the fake ssh stub is wired up', async () => {
    const { stderr } = await run('ssh', ['-O', 'check', '-S', 'x', 'dummy']);
    expect(stderr).toContain('pid=4242');
  });

  it('a SECOND manager adopts the first one`s forward instead of minting another', async () => {
    // Two managers = two processes sharing one master. This is the regression:
    // before the map was persisted, the second minted a second forward.
    const a = newManager();
    const sshDir = join(dir, 'boxssh');
    await a.open({ boxId: 'box1', vpsHost: '1.2.3.4', vpsUser: 'root', boxSshDir: sshDir });
    const first = await a.forward('box1', 18789);
    expect(await forwardCount()).toBe(1);

    await listenOn(first);

    const b = newManager();
    await b.open({ boxId: 'box1', vpsHost: '1.2.3.4', vpsUser: 'root', boxSshDir: sshDir });
    const second = await b.forward('box1', 18789);

    expect(second).toBe(first);
    expect(await forwardCount(), 'no second forward should be minted').toBe(1);
  });

  it('a RESTARTED master invalidates the map rather than handing back a dead port', async () => {
    const a = newManager();
    const sshDir = join(dir, 'boxssh2');
    await a.open({ boxId: 'box2', vpsHost: '1.2.3.4', vpsUser: 'root', boxSshDir: sshDir });
    const first = await a.forward('box2', 18789);
    await listenOn(first);

    // Same socket path, different master: its forwards are gone with it.
    await installFakeSsh(9999);

    const b = newManager();
    await b.open({ boxId: 'box2', vpsHost: '1.2.3.4', vpsUser: 'root', boxSshDir: sshDir });
    const second = await b.forward('box2', 18789);
    expect(await forwardCount(), 'a new master must mint a fresh forward').toBe(2);
    expect(second).not.toBe(first);
  });
});
