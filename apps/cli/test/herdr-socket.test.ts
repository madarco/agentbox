import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { herdrRequest } from '../src/terminal/herdr-socket.js';

/**
 * Spins up a throwaway UNIX-socket "Herdr" whose per-connection handler is
 * supplied by each test, so we can exercise the JSON-RPC correlation logic
 * (notifications, out-of-order ids, slow replies) without a real Herdr.
 */
function fakeHerdr(
  onLine: (line: Record<string, unknown>, sock: net.Socket) => void,
): { path: string; close: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-sock-'));
  const path = join(dir, 'h.sock');
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        onLine(JSON.parse(line) as Record<string, unknown>, sock);
      }
    });
    sock.on('error', () => {});
  });
  server.listen(path);
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

describe('herdrRequest', () => {
  let herdr: { path: string; close: () => Promise<void> } | undefined;
  const env = (path: string): NodeJS.ProcessEnv => ({ HERDR_SOCKET_PATH: path });

  afterEach(async () => {
    await herdr?.close();
    herdr = undefined;
  });

  it('returns null when no socket is configured', async () => {
    expect(await herdrRequest('tab.create', {}, {})).toBeNull();
  });

  it('resolves the matching reply by id', async () => {
    herdr = fakeHerdr((req, sock) => {
      sock.write(`${JSON.stringify({ id: req.id, result: { root_pane: { pane_id: 'w1:p2' } } })}\n`);
    });
    const r = await herdrRequest('tab.create', {}, env(herdr.path));
    expect(r).toEqual({ root_pane: { pane_id: 'w1:p2' } });
  });

  it('skips a notification pushed before the reply (the concurrency bug)', async () => {
    // Herdr emits a focus/layout notification first, then the actual reply.
    herdr = fakeHerdr((req, sock) => {
      sock.write(`${JSON.stringify({ method: 'layout.changed', params: { foo: 1 } })}\n`);
      sock.write(`${JSON.stringify({ id: req.id, result: { pane_id: 'w3:p7' } })}\n`);
    });
    const r = await herdrRequest('tab.create', {}, env(herdr.path));
    expect(r).toEqual({ pane_id: 'w3:p7' });
  });

  it("skips another request's reply (different id) and waits for ours", async () => {
    herdr = fakeHerdr((req, sock) => {
      sock.write(`${JSON.stringify({ id: 'someone-else:99', result: { pane_id: 'x:p1' } })}\n`);
      sock.write(`${JSON.stringify({ id: req.id, result: { pane_id: 'ours:p1' } })}\n`);
    });
    const r = await herdrRequest('tab.create', {}, env(herdr.path));
    expect(r).toEqual({ pane_id: 'ours:p1' });
  });

  it('accepts an id-less reply (non-compliant Herdr) without regressing', async () => {
    herdr = fakeHerdr((_req, sock) => {
      sock.write(`${JSON.stringify({ result: { pane_id: 'noid:p1' } })}\n`);
    });
    const r = await herdrRequest('tab.create', {}, env(herdr.path));
    expect(r).toEqual({ pane_id: 'noid:p1' });
  });

  it('returns null on an error reply', async () => {
    herdr = fakeHerdr((req, sock) => {
      sock.write(`${JSON.stringify({ id: req.id, error: { message: 'busy' } })}\n`);
    });
    expect(await herdrRequest('tab.create', {}, env(herdr.path))).toBeNull();
  });

  it('times out (returns null) when no matching reply ever arrives', async () => {
    herdr = fakeHerdr((_req, sock) => {
      // Only ever send notifications — never our reply.
      sock.write(`${JSON.stringify({ method: 'noise' })}\n`);
    });
    expect(await herdrRequest('tab.create', {}, env(herdr.path), 150)).toBeNull();
  });

  it('handles a reply split across two data chunks', async () => {
    herdr = fakeHerdr((req, sock) => {
      const full = JSON.stringify({ id: req.id, result: { pane_id: 'split:p1' } });
      const mid = Math.floor(full.length / 2);
      sock.write(full.slice(0, mid));
      setTimeout(() => sock.write(`${full.slice(mid)}\n`), 20);
    });
    const r = await herdrRequest('tab.create', {}, env(herdr.path));
    expect(r).toEqual({ pane_id: 'split:p1' });
  });
});
