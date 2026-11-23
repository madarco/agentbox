import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchHistoryConfig } from '../src/history-shipper.js';
import { relayMemoryRpc } from '../src/memory-sync.js';
import { relayNotReady } from '../src/relay-rpc.js';

// A cloud box's ctl starts before the hub registers it, so the relay answers
// its first RPCs with 401 "unknown box token". That must read as "ask again
// soon", not as an older relay that lacks the method (501), which parks the
// feature for 10 minutes; for memory the late seed then replaced files the
// agent had already written.
describe('relay not ready vs unsupported', () => {
  let server: Server;
  let status = 401;
  const prev = {
    url: process.env.AGENTBOX_RELAY_URL,
    token: process.env.AGENTBOX_RELAY_TOKEN,
    envFile: process.env.AGENTBOX_RELAY_ENV_FILE,
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            status === 401
              ? { error: 'unknown box token' }
              : { error: 'rpc method not implemented' },
          ),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    process.env.AGENTBOX_RELAY_URL = `http://127.0.0.1:${String(port)}`;
    process.env.AGENTBOX_RELAY_TOKEN = 'stub';
    // Never fall back to a real /run/agentbox/relay.env on the test machine.
    process.env.AGENTBOX_RELAY_ENV_FILE = '/nonexistent/relay.env';
  });

  afterAll(async () => {
    if (prev.url === undefined) delete process.env.AGENTBOX_RELAY_URL;
    else process.env.AGENTBOX_RELAY_URL = prev.url;
    if (prev.token === undefined) delete process.env.AGENTBOX_RELAY_TOKEN;
    else process.env.AGENTBOX_RELAY_TOKEN = prev.token;
    if (prev.envFile === undefined) delete process.env.AGENTBOX_RELAY_ENV_FILE;
    else process.env.AGENTBOX_RELAY_ENV_FILE = prev.envFile;
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  it('classifies the exit codes and statuses', () => {
    expect(relayNotReady({ exitCode: 65 })).toBe(true);
    expect(relayNotReady({ exitCode: 126 })).toBe(true);
    expect(relayNotReady({ exitCode: 1, httpStatus: 401 }, 10)).toBe(true);
    // A box still unknown long after boot is not a registration race.
    expect(relayNotReady({ exitCode: 1, httpStatus: 401 }, 3600)).toBe(false);
    expect(relayNotReady({ exitCode: 1, httpStatus: 501 })).toBe(false);
    expect(relayNotReady({ exitCode: 1 })).toBe(false);
  });

  it('a 401 is unreachable for the memory seed and the history config', async () => {
    status = 401;
    expect(await relayMemoryRpc.seed()).toBe('unreachable');
    expect((await fetchHistoryConfig()).kind).toBe('unreachable');
  });

  it('a 501 is still unsupported', async () => {
    status = 501;
    expect(await relayMemoryRpc.seed()).toBe('unsupported');
    expect((await fetchHistoryConfig()).kind).toBe('unsupported');
  });
});
