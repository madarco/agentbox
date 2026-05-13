import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { describe, expect, it, afterEach } from 'vitest';
import { startProbe } from '../src/probe.js';
import type { LogEvent } from '../src/types.js';
import type { HttpProbe, LogMatchProbe, PortProbe } from '../src/config.js';

const PROBE_DEFAULTS = {
  intervalMs: 30,
  initialDelayMs: 0,
  timeoutMs: 1500,
  onTimeout: 'kill' as const,
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe('probe — port', () => {
  let server: NetServer | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  it('resolves ready when the port becomes reachable', async () => {
    const port = await freePort();
    const probe: PortProbe = {
      kind: 'port',
      port,
      host: '127.0.0.1',
      ...PROBE_DEFAULTS,
    };
    const handle = startProbe(probe, {});

    // Open the listener shortly after the probe starts.
    setTimeout(() => {
      server = createNetServer().listen(port);
    }, 50);

    expect(await handle.result).toBe('ready');
  });

  it('times out when nothing is listening', async () => {
    const port = await freePort();
    const probe: PortProbe = {
      kind: 'port',
      port,
      host: '127.0.0.1',
      ...PROBE_DEFAULTS,
      timeoutMs: 200,
    };
    const handle = startProbe(probe, {});
    expect(await handle.result).toBe('timed_out');
  });

  it('aborts cleanly', async () => {
    const port = await freePort();
    const probe: PortProbe = {
      kind: 'port',
      port,
      host: '127.0.0.1',
      ...PROBE_DEFAULTS,
      timeoutMs: 5000,
    };
    const handle = startProbe(probe, {});
    handle.abort();
    expect(await handle.result).toBe('aborted');
  });
});

describe('probe — log_match', () => {
  it('resolves on first matching line', async () => {
    const subscribers: Array<(ev: LogEvent) => void> = [];
    const probe: LogMatchProbe = {
      kind: 'log_match',
      pattern: /listening on \d+/,
      timeoutMs: 1500,
      onTimeout: 'kill',
    };
    const handle = startProbe(probe, {
      subscribeLogs: (cb) => {
        subscribers.push(cb);
        return () => {
          const i = subscribers.indexOf(cb);
          if (i >= 0) subscribers.splice(i, 1);
        };
      },
    });

    setTimeout(() => {
      subscribers.forEach((cb) =>
        cb({ service: 'x', ts: 't', stream: 'stdout', line: 'noise' }),
      );
      subscribers.forEach((cb) =>
        cb({ service: 'x', ts: 't', stream: 'stdout', line: 'listening on 3000' }),
      );
    }, 30);

    expect(await handle.result).toBe('ready');
  });

  it('times out if no line matches', async () => {
    const probe: LogMatchProbe = {
      kind: 'log_match',
      pattern: /nope/,
      timeoutMs: 150,
      onTimeout: 'kill',
    };
    const handle = startProbe(probe, {
      subscribeLogs: () => () => {},
    });
    expect(await handle.result).toBe('timed_out');
  });
});

describe('probe — http', () => {
  let server: HttpServer | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  async function startWithStatus(status: number): Promise<void> {
    port = await freePort();
    await new Promise<void>((resolve) => {
      server = createHttpServer((_req, res) => {
        res.statusCode = status;
        res.end('ok');
      });
      server.listen(port, resolve);
    });
  }

  it('resolves ready on 2xx (default expect_status)', async () => {
    await startWithStatus(204);
    const probe: HttpProbe = {
      kind: 'http',
      url: `http://127.0.0.1:${String(port)}/`,
      ...PROBE_DEFAULTS,
    };
    const handle = startProbe(probe, {});
    expect(await handle.result).toBe('ready');
  });

  it('keeps polling when status is unexpected', async () => {
    await startWithStatus(500);
    const probe: HttpProbe = {
      kind: 'http',
      url: `http://127.0.0.1:${String(port)}/`,
      ...PROBE_DEFAULTS,
      timeoutMs: 250,
    };
    const handle = startProbe(probe, {});
    expect(await handle.result).toBe('timed_out');
  });

  it('respects an explicit expect_status', async () => {
    await startWithStatus(201);
    const probe: HttpProbe = {
      kind: 'http',
      url: `http://127.0.0.1:${String(port)}/`,
      expectStatus: 201,
      ...PROBE_DEFAULTS,
    };
    const handle = startProbe(probe, {});
    expect(await handle.result).toBe('ready');
  });
});
