import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebProxy } from '../src/web-proxy.js';

/**
 * The forwarder must SAY when it could not bind.
 *
 * A failed bind reached only `/var/log/agentbox/web-proxy.log`, so a cloud box
 * whose reserved port was already held by its own portless proxy still reported
 * ready and still handed out a URL — one answered by portless, with a 302 into
 * a 404. `state()` is what carries the failure into the status snapshot.
 */
const listeners: Server[] = [];
const proxies: WebProxy[] = [];

afterEach(() => {
  for (const p of proxies.splice(0)) p.stop();
  for (const s of listeners.splice(0)) s.close();
});

/** Occupy a port and return it, so the proxy's bind is guaranteed to fail. */
async function occupiedPort(): Promise<number> {
  const s = createServer();
  listeners.push(s);
  await new Promise<void>((r) => s.listen(0, '0.0.0.0', r));
  const addr = s.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

describe('WebProxy.state', () => {
  it('reports the port and target with no error once bound', async () => {
    const logPath = join(await mkdtemp(join(tmpdir(), 'wp-')), 'web-proxy.log');
    const proxy = new WebProxy(0, logPath);
    proxies.push(proxy);
    proxy.reconfigure(4321);
    await settle();
    expect(proxy.state()).toEqual({ port: 0, target: 4321 });
  });

  it('reports null target when nothing is exposed', () => {
    const proxy = new WebProxy(0, join(tmpdir(), 'unused.log'));
    proxies.push(proxy);
    expect(proxy.state().target).toBeNull();
  });

  it('records a bind failure instead of only logging it', async () => {
    const taken = await occupiedPort();
    const logPath = join(await mkdtemp(join(tmpdir(), 'wp-')), 'web-proxy.log');
    const proxy = new WebProxy(taken, logPath);
    proxies.push(proxy);
    proxy.reconfigure(4321);
    await settle();

    const state = proxy.state();
    expect(state.port).toBe(taken);
    // The target is still what it was asked to forward to: the SERVICE is fine,
    // it is the publish that is broken, and conflating the two sends whoever
    // reads this to the wrong place.
    expect(state.target).toBe(4321);
    expect(state.error).toMatch(/EADDRINUSE/);
    // Still logged as well — the log is what a person tails inside the box.
    expect(await readFile(logPath, 'utf8')).toMatch(/EADDRINUSE/);
  });

  it('clears the error when pointed at a new target', async () => {
    const taken = await occupiedPort();
    const proxy = new WebProxy(taken, join(await mkdtemp(join(tmpdir(), 'wp-')), 'p.log'));
    proxies.push(proxy);
    proxy.reconfigure(4321);
    await settle();
    expect(proxy.state().error).toBeDefined();

    // A reconfigure is a fresh attempt; carrying the old failure forward would
    // make a healthy box look broken until its next restart.
    proxy.reconfigure(null);
    expect(proxy.state()).toEqual({ port: taken, target: null });
  });
});
