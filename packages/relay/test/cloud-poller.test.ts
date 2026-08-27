import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudBoxPoller } from '../src/cloud-poller.js';

/**
 * Helpers to spin up a tiny `/bridge/poll` server returning an empty action
 * batch, and to vend a guaranteed-refused port (bind + close, kernel may not
 * race-rebind it inside the test's lifetime).
 */
function bridgeStub(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/bridge/poll')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ actions: [], events: [], status: null, cursor: 0 }));
        return;
      }
      res.statusCode = 404;
      res.end('');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('no addr');
      }
      resolve({
        url: `http://127.0.0.1:${String(addr.port)}`,
        close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

async function refusedUrl(): Promise<string> {
  // Bind, capture port, immediately close. Connect attempts to it during the
  // test's lifetime will get ECONNREFUSED.
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      const port = addr.port;
      s.close(() => resolve(`http://127.0.0.1:${String(port)}`));
    });
  });
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      await fn?.();
    } catch {
      // ignore
    }
  }
});

describe('CloudBoxPoller recoverPreviewUrl', () => {
  it('calls recoverPreviewUrl on ECONNREFUSED and switches to the new URL', async () => {
    const live = await bridgeStub();
    cleanups.push(live.close);
    const dead = await refusedUrl();
    const calls: string[] = [];
    let recoveryCount = 0;
    const poller = new CloudBoxPoller({
      boxId: 'test-box',
      previewUrl: dead,
      bridgeToken: 'tok',
      logger: (line) => calls.push(line),
      recoverPreviewUrl: async () => {
        recoveryCount += 1;
        return live.url;
      },
    });
    poller.start();
    // Wait until the poller has logged at least one successful URL recovery.
    // We don't poll on a hard timer — instead poll the logger output.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (calls.some((l) => l.includes('preview URL recovered'))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await poller.stop();
    expect(recoveryCount).toBeGreaterThanOrEqual(1);
    expect(calls.some((l) => l.includes(`preview URL recovered: ${dead} → ${live.url}`))).toBe(
      true,
    );
  });

  it('does not loop the recover call on a single failure burst (in-flight de-dupe)', async () => {
    const dead = await refusedUrl();
    let recoveryCount = 0;
    const poller = new CloudBoxPoller({
      boxId: 'test-box',
      previewUrl: dead,
      bridgeToken: 'tok',
      logger: () => {},
      recoverPreviewUrl: async () => {
        recoveryCount += 1;
        // Slow recovery — simulates an ssh-tunnel reopen.
        await new Promise((r) => setTimeout(r, 100));
        return null; // keep the (dead) URL so the next poll fails again
      },
    });
    poller.start();
    // Let a few poll cycles fire — each one will see ECONNREFUSED. With the
    // in-flight guard each recoveryCount bump matches one COMPLETED recovery,
    // not the parallel storms that would otherwise happen.
    await new Promise((r) => setTimeout(r, 600));
    await poller.stop();
    // Without de-dupe we'd see dozens; with it the count tracks completed
    // sequential calls. Loose upper bound; tight enough to catch a storm.
    expect(recoveryCount).toBeLessThan(20);
    expect(recoveryCount).toBeGreaterThanOrEqual(1);
  });

  it('does not call recoverPreviewUrl on a non-connection error (e.g. 504)', async () => {
    const slow504 = createServer((req, res) => {
      if (req.url?.startsWith('/bridge/poll')) {
        res.statusCode = 504;
        res.end('gateway timeout');
        return;
      }
      res.statusCode = 404;
      res.end('');
    });
    await new Promise<void>((r) => slow504.listen(0, '127.0.0.1', r));
    const addr = slow504.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const url = `http://127.0.0.1:${String(addr.port)}`;
    cleanups.push(() => new Promise((r, j) => slow504.close((e) => (e ? j(e) : r()))));
    let recoveryCount = 0;
    const poller = new CloudBoxPoller({
      boxId: 'test-box',
      previewUrl: url,
      bridgeToken: 'tok',
      logger: () => {},
      recoverPreviewUrl: async () => {
        recoveryCount += 1;
        return null;
      },
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 400));
    await poller.stop();
    expect(recoveryCount).toBe(0);
  });
});

describe('CloudBoxPoller stop', () => {
  /** A bridge that accepts `/bridge/poll` and never answers — a real long-poll. */
  function hangingBridge(): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const open: import('node:http').ServerResponse[] = [];
      const server = createServer((req, res) => {
        if (req.url?.startsWith('/bridge/poll')) {
          open.push(res); // never respond
          return;
        }
        res.statusCode = 404;
        res.end('');
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no addr');
        resolve({
          url: `http://127.0.0.1:${String(addr.port)}`,
          close: () =>
            new Promise((r) => {
              for (const res of open) res.destroy();
              server.close(() => r());
            }),
        });
      });
    });
  }

  it('aborts the in-flight poll instead of waiting it out', async () => {
    // Measured before the abort landed: stop() took 26s against a bridge that
    // never answers. That is a 26s window in which a late poll can revive a box
    // the caller just paused on an auto-resuming backend (e2b).
    const bridge = await hangingBridge();
    cleanups.push(bridge.close);
    const poller = new CloudBoxPoller({
      boxId: 'test-box',
      previewUrl: bridge.url,
      bridgeToken: 'tok',
      logger: () => {},
    });

    poller.start();
    await new Promise((r) => setTimeout(r, 300)); // let the poll get established
    const t0 = Date.now();
    await poller.stop();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('does not report the stop-abort as a poll error', async () => {
    // The abort surfaces as a socket error; logging it would cry wolf on every
    // pause, and falling through to backoff/recovery would be actively wrong.
    const bridge = await hangingBridge();
    cleanups.push(bridge.close);
    const lines: string[] = [];
    let recoveryCount = 0;
    const poller = new CloudBoxPoller({
      boxId: 'test-box',
      previewUrl: bridge.url,
      bridgeToken: 'tok',
      logger: (l: string) => lines.push(l),
      recoverPreviewUrl: async () => {
        recoveryCount += 1;
        return null;
      },
    });

    poller.start();
    await new Promise((r) => setTimeout(r, 300));
    await poller.stop();
    await new Promise((r) => setTimeout(r, 200));

    expect(lines.filter((l) => l.includes('poll error'))).toEqual([]);
    expect(recoveryCount).toBe(0);
  });
});
