import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshTunnelManager, controlSockPath } from '../src/ssh-tunnel.js';

interface ExecaCall {
  argv: string[];
}

vi.mock('execa', () => {
  // The mock records every argv it sees and behaves according to the test's
  // `mockBehavior` map: each subcommand returns a stubbed { exitCode }.
  return {
    execa: vi.fn(async (_cmd: string, argv: string[]) => {
      execaCalls.push({ argv });
      const sub = argv[0]; // -fNT | -O check | -O forward | -O cancel | -O exit
      if (sub === '-fNT') {
        // Master open: simulate the socket appearing by touching the file
        // identified by the `-S` arg.
        const sIdx = argv.indexOf('-S');
        if (sIdx >= 0) {
          const sockPath = argv[sIdx + 1];
          if (sockPath) writeFileSync(sockPath, '');
        }
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      if (sub === '-O') {
        const op = argv[1];
        if (op === 'check') {
          const sIdx = argv.indexOf('-S');
          const sockPath = sIdx >= 0 ? argv[sIdx + 1] ?? '' : '';
          // Alive iff the file exists AND mockBehavior says so.
          if (sockPath && aliveSockets.has(sockPath)) {
            return { exitCode: 0, stderr: '', stdout: '' };
          }
          return { exitCode: 1, stderr: 'no master', stdout: '' };
        }
        if (op === 'forward') {
          return { exitCode: 0, stderr: '', stdout: '' };
        }
        if (op === 'cancel') {
          return { exitCode: 0, stderr: '', stdout: '' };
        }
        if (op === 'exit') {
          const sIdx = argv.indexOf('-S');
          const sockPath = sIdx >= 0 ? argv[sIdx + 1] ?? '' : '';
          if (sockPath) aliveSockets.delete(sockPath);
          return { exitCode: 0, stderr: '', stdout: '' };
        }
      }
      return { exitCode: 0, stderr: '', stdout: '' };
    }),
  };
});

let execaCalls: ExecaCall[] = [];
const aliveSockets = new Set<string>();

beforeEach(() => {
  execaCalls = [];
  aliveSockets.clear();
});

let tmpRoot: string | undefined;
let origHome: string | undefined;
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  origHome = undefined;
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

function makeIdentity(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentbox-ssh-tunnel-test-'));
  // Point HOME at the temp root so the short ControlMaster socket
  // (`$HOME/.agentbox/cm/<hash>.sock`) lands under it and gets cleaned up,
  // instead of polluting the developer's real ~/.agentbox.
  origHome = process.env.HOME;
  process.env.HOME = tmpRoot;
  const id = join(tmpRoot, 'id_ed25519');
  writeFileSync(id, 'fake-key', { mode: 0o600 });
  return id;
}

describe('SshTunnelManager.forward', () => {
  it('returns cached localPort when the ControlMaster is alive', async () => {
    const m = new SshTunnelManager();
    const identity = makeIdentity();
    const boxSshDir = join(tmpRoot!, 'box-ssh');
    await m.open({ boxId: 'b1', vpsHost: '1.2.3.4', identity, boxSshDir });
    aliveSockets.add(controlSockPath(boxSshDir));
    const p1 = await m.forward('b1', 8788);
    const p2 = await m.forward('b1', 8788);
    expect(p1).toBe(p2);
    // Only ONE `-O forward` call should have fired across both forward() invocations.
    const forwardCalls = execaCalls.filter((c) => c.argv[0] === '-O' && c.argv[1] === 'forward');
    expect(forwardCalls).toHaveLength(1);
  });

  it('drops cached forwards and re-mints when the ControlMaster is dead', async () => {
    const m = new SshTunnelManager();
    const identity = makeIdentity();
    const boxSshDir = join(tmpRoot!, 'box-ssh');
    await m.open({ boxId: 'b1', vpsHost: '1.2.3.4', identity, boxSshDir });
    aliveSockets.add(controlSockPath(boxSshDir));
    const p1 = await m.forward('b1', 8788);
    // Master dies (e.g. host sleep/wake).
    aliveSockets.delete(controlSockPath(boxSshDir));
    const p2 = await m.forward('b1', 8788);
    expect(p1).toBeTypeOf('number');
    expect(p2).toBeTypeOf('number');
    // Two `-O forward` calls — second one re-minted after we detected the dead master.
    const forwardCalls = execaCalls.filter((c) => c.argv[0] === '-O' && c.argv[1] === 'forward');
    expect(forwardCalls).toHaveLength(2);
  });
});

describe('SshTunnelManager.refresh', () => {
  it('clears cached forwards and re-opens the master', async () => {
    const m = new SshTunnelManager();
    const identity = makeIdentity();
    const boxSshDir = join(tmpRoot!, 'box-ssh');
    await m.open({ boxId: 'b1', vpsHost: '1.2.3.4', identity, boxSshDir });
    aliveSockets.add(controlSockPath(boxSshDir));
    await m.forward('b1', 8788);
    // Simulate dead master.
    aliveSockets.delete(controlSockPath(boxSshDir));
    await m.refresh({ boxId: 'b1', vpsHost: '1.2.3.4', identity, boxSshDir });
    // After refresh, forward() should re-mint.
    aliveSockets.add(controlSockPath(boxSshDir));
    const newPort = await m.forward('b1', 8788);
    expect(newPort).toBeTypeOf('number');
    const opens = execaCalls.filter((c) => c.argv[0] === '-fNT');
    // One initial open + one refresh open.
    expect(opens).toHaveLength(2);
  });

  it('is idempotent when no master is registered (just open)', async () => {
    const m = new SshTunnelManager();
    const identity = makeIdentity();
    const boxSshDir = join(tmpRoot!, 'box-ssh');
    await m.refresh({ boxId: 'b1', vpsHost: '1.2.3.4', identity, boxSshDir });
    const opens = execaCalls.filter((c) => c.argv[0] === '-fNT');
    expect(opens).toHaveLength(1);
  });
});
