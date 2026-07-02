import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';
import { startRelayDaemon, type RelayDaemonHandle } from '../src/daemon.js';

async function get(handle: RelayServerHandle, path: string): Promise<{ status: number; text: string }> {
  const port = (handle.server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return { status: res.status, text: await res.text() };
}

describe('uiHandler seam', () => {
  let handle: RelayServerHandle;
  let prevPromptEnv: string | undefined;
  let uiCalls: number;

  const uiHandler = (req: IncomingMessage, res: ServerResponse): void => {
    uiCalls += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(`UI:${req.url ?? ''}`);
  };

  beforeEach(async () => {
    prevPromptEnv = process.env.AGENTBOX_PROMPT;
    process.env.AGENTBOX_PROMPT = 'off';
    uiCalls = 0;
    handle = await startRelayServer({ port: 0, host: '127.0.0.1', uiHandler });
  });

  afterEach(async () => {
    await handle.close();
    if (prevPromptEnv === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPromptEnv;
  });

  it('a handled relay route bypasses the uiHandler', async () => {
    // /healthz is a real relay route: it must match before the 404 fallthrough
    // where the delegate lives, so the UI can never shadow relay routes.
    const r = await get(handle, '/healthz');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true });
    expect(uiCalls).toBe(0);
  });

  it('an unknown route is delegated to the uiHandler', async () => {
    const r = await get(handle, '/anything-else');
    expect(r.status).toBe(200);
    expect(r.text).toBe('UI:/anything-else');
    expect(uiCalls).toBe(1);
  });
});

describe('no uiHandler → 404 fallthrough unchanged', () => {
  let handle: RelayServerHandle;
  let prevPromptEnv: string | undefined;

  beforeEach(async () => {
    prevPromptEnv = process.env.AGENTBOX_PROMPT;
    process.env.AGENTBOX_PROMPT = 'off';
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
    if (prevPromptEnv === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPromptEnv;
  });

  it('unknown route returns the not-found JSON', async () => {
    const r = await get(handle, '/anything-else');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'not found', route: 'GET /anything-else' });
  });
});

describe('startRelayDaemon', () => {
  let daemon: RelayDaemonHandle;
  let prevPromptEnv: string | undefined;

  beforeEach(async () => {
    prevPromptEnv = process.env.AGENTBOX_PROMPT;
    process.env.AGENTBOX_PROMPT = 'off';
    daemon = await startRelayDaemon({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    if (prevPromptEnv === undefined) delete process.env.AGENTBOX_PROMPT;
    else process.env.AGENTBOX_PROMPT = prevPromptEnv;
  });

  it('boots the server + loops and stops cleanly', async () => {
    expect(daemon.handle.server.listening).toBe(true);
    const r = await get(daemon.handle, '/healthz');
    expect(r.status).toBe(200);
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(daemon.handle.server.listening).toBe(false);
  });
});
