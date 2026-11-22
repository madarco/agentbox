import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLlmProxyServer,
  llmProxyHosts,
  parseConnectTarget,
  parseProxyAuth,
} from '../src/llm-proxy.js';

const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;

describe('parseProxyAuth / parseConnectTarget', () => {
  it('parses Basic boxId:token, refuses anything else', () => {
    expect(parseProxyAuth(basic('agentbox:tok:en'))).toEqual({ token: 'tok:en' });
    expect(parseProxyAuth(basic(':tok'))).toEqual({ token: 'tok' });
    expect(parseProxyAuth(undefined)).toBeNull();
    expect(parseProxyAuth('Bearer x')).toBeNull();
    expect(parseProxyAuth(basic('box1:'))).toBeNull();
  });
  it('parses host:port, lowercased', () => {
    expect(parseConnectTarget('API.Anthropic.com:443')).toEqual({
      host: 'api.anthropic.com',
      port: 443,
    });
    expect(parseConnectTarget('api.anthropic.com')).toBeNull();
    expect(parseConnectTarget('[::1]:443')).toBeNull();
    expect(parseConnectTarget('h:99999')).toBeNull();
  });
  it('the allowlist is the registry llmHosts (claude + codex), no telemetry', () => {
    const hosts = llmProxyHosts();
    expect(hosts).toEqual(
      expect.arrayContaining([
        'api.anthropic.com',
        'platform.claude.com',
        'chatgpt.com',
        'auth.openai.com',
      ]),
    );
    expect(hosts).not.toContain('statsig.anthropic.com');
    expect(hosts).not.toContain('github.com');
  });
});

describe('createLlmProxyServer', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    while (closers.length) closers.pop()!();
  });

  /** An "upstream" echo server, and a proxy whose connect() always lands on it. */
  async function setup() {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const echoPort = (echo.address() as AddressInfo).port;
    const dialed: string[] = [];
    const proxy = createLlmProxyServer({
      authorize: async (token) => (token === 'good' ? 'box1' : null),
      allowedHosts: () => ['api.anthropic.com'],
      connect: (port, host) => {
        dialed.push(`${host}:${String(port)}`);
        return host === 'api.anthropic.com'
          ? net.connect(echoPort, '127.0.0.1')
          : net.connect(1, '127.0.0.1');
      },
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    closers.push(
      () => echo.close(),
      () => proxy.close(),
    );
    return { port: (proxy.address() as AddressInfo).port, dialed };
  }

  /** Send a CONNECT, then (on 200) a payload; resolve with everything read. */
  function connect(port: number, target: string, auth?: string, payload = 'ping'): Promise<string> {
    return new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      let buf = '';
      let sent = false;
      s.on('data', (d) => {
        buf += d.toString();
        if (!sent && buf.includes('200 Connection Established\r\n\r\n')) {
          sent = true;
          s.write(payload);
        }
        if (sent && buf.endsWith(payload)) s.end();
      });
      s.on('close', () => resolve(buf));
      s.on('error', () => resolve(buf));
      s.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`,
      );
    });
  }

  it('tunnels an allowlisted host for a registered box', async () => {
    const { port, dialed } = await setup();
    const out = await connect(port, 'api.anthropic.com:443', basic('box1:good'));
    expect(out).toContain('200 Connection Established');
    expect(out.endsWith('ping')).toBe(true);
    expect(dialed).toEqual(['api.anthropic.com:443']);
  });

  it('407 without a credential or with a wrong token; nothing dialed', async () => {
    const { port, dialed } = await setup();
    expect(await connect(port, 'api.anthropic.com:443')).toContain(
      '407 Proxy Authentication Required',
    );
    expect(await connect(port, 'api.anthropic.com:443', basic('box1:bad'))).toContain('407');
    expect(dialed).toEqual([]);
  });

  it('403 for a host off the allowlist or a port other than 443', async () => {
    const { port, dialed } = await setup();
    const off = await connect(port, 'example.com:443', basic('box1:good'));
    expect(off).toContain('403 Forbidden');
    expect(off).toContain('example.com is not an LLM host');
    expect(await connect(port, 'api.anthropic.com:80', basic('box1:good'))).toContain('403');
    expect(dialed).toEqual([]);
  });

  it('502 naming the host when the upstream is unreachable', async () => {
    const echo = net.createServer();
    const proxy = createLlmProxyServer({
      authorize: async () => 'box1',
      allowedHosts: () => ['api.anthropic.com'],
      connect: () => net.connect(1, '127.0.0.1'),
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    closers.push(
      () => echo.close(),
      () => proxy.close(),
    );
    const out = await connect(
      (proxy.address() as AddressInfo).port,
      'api.anthropic.com:443',
      basic('b:t'),
    );
    expect(out).toContain('502 Bad Gateway');
    expect(out).toContain('cannot reach api.anthropic.com');
  });

  it('a plain HTTP request is refused (CONNECT only)', async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(res.status).toBe(405);
  });
});
