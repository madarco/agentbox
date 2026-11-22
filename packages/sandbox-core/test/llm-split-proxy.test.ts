import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LLM_SPLIT_PROXY_SCRIPT,
  isValidLlmProxyUpstream,
  llmProxyLaunchPreamble,
  resolveLlmProxyRecord,
} from '../src/llm-split-proxy.js';

const run = promisify(execFile);

describe('llmProxyLaunchPreamble', () => {
  const rec = { mode: 'forward' as const, upstream: 'hub.example.com:8790' };
  it('is empty without a proxy, or for an agent with no model hosts', () => {
    expect(llmProxyLaunchPreamble(undefined, ['api.anthropic.com'])).toBe('');
    expect(llmProxyLaunchPreamble(rec, undefined)).toBe('');
    expect(llmProxyLaunchPreamble(rec, [])).toBe('');
  });
  it('points the agent at the local split proxy, carries no single quote and no token', () => {
    const p = llmProxyLaunchPreamble(rec, ['api.anthropic.com', 'platform.claude.com']);
    expect(p).toContain('export HTTPS_PROXY=http://127.0.0.1:47290');
    expect(p).toContain(
      '--ensure 47290 hub.example.com:8790 api.anthropic.com,platform.claude.com',
    );
    expect(p).not.toContain("'");
    expect(p).not.toMatch(/RELAY_TOKEN=/);
  });
  it('refuses an upstream or host that is not shell-safe', () => {
    expect(() =>
      llmProxyLaunchPreamble({ mode: 'forward', upstream: 'a;b:1' }, ['x.com']),
    ).toThrow();
    expect(() => llmProxyLaunchPreamble(rec, ['x.com;rm'])).toThrow();
    expect(isValidLlmProxyUpstream('host.docker.internal:8790')).toBe(true);
    expect(isValidLlmProxyUpstream('h:0')).toBe(false);
    expect(isValidLlmProxyUpstream('h')).toBe(false);
  });
  it('runs under sh: writes the script, ensures the proxy, exports the env', async () => {
    // Under a scratch HOME the script lands there; the --ensure fails fast (no
    // such upstream needed: it only checks the LOCAL listener comes up).
    const home = mkdtempSync(join(tmpdir(), 'llmsp-'));
    const p = llmProxyLaunchPreamble({ mode: 'forward', upstream: '127.0.0.1:9' }, [
      'api.anthropic.com',
    ]);
    const { stdout } = await run(
      'sh',
      ['-c', `${p}echo "$HTTPS_PROXY"; node -e "process.exit(0)"`],
      {
        env: { ...process.env, HOME: home },
      },
    );
    expect(stdout.trim()).toBe('http://127.0.0.1:47290');
    // `[l]lm` keeps the pattern from matching this pkill's own command line.
    await run('sh', ['-c', 'pkill -f "[l]lm-split-proxy.cjs 47290 127.0.0.1:9"; true']);
  });
});

describe('the split proxy script', () => {
  let echoPort = 0;
  let hubPort = 0;
  let proxyPort = 0;
  const hubSaw: string[] = [];
  const servers: net.Server[] = [];
  let child: ReturnType<typeof spawn> | undefined;

  beforeAll(async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    echoPort = (echo.address() as AddressInfo).port;
    // A fake hub proxy: records the CONNECT head; 200 + echo for the good token.
    const hub = net.createServer((s) => {
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('latin1');
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        s.removeListener('data', onData);
        hubSaw.push(buf.slice(0, end));
        const good = buf.includes(`Basic ${Buffer.from('agentbox:tok').toString('base64')}`);
        if (!good) {
          s.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 9\r\n\r\nbad token');
          return;
        }
        s.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = buf.slice(end + 4);
        if (rest) s.write(rest);
        s.pipe(s);
      };
      s.on('data', onData);
    });
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', () => r()));
    hubPort = (hub.address() as AddressInfo).port;
    servers.push(echo, hub);
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    proxyPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const dir = mkdtempSync(join(tmpdir(), 'llmsp-'));
    const file = join(dir, 'sp.cjs');
    writeFileSync(file, LLM_SPLIT_PROXY_SCRIPT);
    child = spawn(
      process.execPath,
      [file, String(proxyPort), `127.0.0.1:${String(hubPort)}`, 'api.anthropic.com'],
      {
        env: { ...process.env, AGENTBOX_RELAY_TOKEN: 'tok' },
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 50; i++) {
      const up = await new Promise<boolean>((r) => {
        const s = net.connect(proxyPort, '127.0.0.1', () => (s.end(), r(true)));
        s.on('error', () => r(false));
      });
      if (up) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterAll(() => {
    child?.kill();
    for (const s of servers) s.close();
  });

  function tunnel(target: string, payload = 'ping'): Promise<string> {
    return new Promise((resolve) => {
      const s = net.connect(proxyPort, '127.0.0.1');
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
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
  }

  it('sends a model host through the hub with the box token, never to the agent', async () => {
    const out = await tunnel('api.anthropic.com:443');
    expect(out).toContain('200 Connection Established');
    expect(out.endsWith('ping')).toBe(true);
    expect(hubSaw.at(-1)).toContain('CONNECT api.anthropic.com:443');
    expect(hubSaw.at(-1)).toContain(`Basic ${Buffer.from('agentbox:tok').toString('base64')}`);
  });

  it('sends any other host direct (not via the hub)', async () => {
    const before = hubSaw.length;
    const out = await tunnel(`127.0.0.1:${String(echoPort)}`);
    expect(out.endsWith('ping')).toBe(true);
    expect(hubSaw.length).toBe(before);
  });

  it('answers the --ensure probe with its own upstream, so a second start is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmsp-'));
    const file = join(dir, 'sp.cjs');
    writeFileSync(file, LLM_SPLIT_PROXY_SCRIPT);
    await expect(
      run(process.execPath, [
        file,
        '--ensure',
        String(proxyPort),
        `127.0.0.1:${String(hubPort)}`,
        'api.anthropic.com',
      ]),
    ).resolves.toBeDefined();
  });
});

describe('the split proxy script: hub refusals and outages', () => {
  it('passes the hub refusal through and answers 502 naming the hub when it is down', async () => {
    const hub = net.createServer((s) =>
      s.on('data', () =>
        s.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 9\r\n\r\nbad token'),
      ),
    );
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', () => r()));
    const hubPort = (hub.address() as AddressInfo).port;
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const dir = mkdtempSync(join(tmpdir(), 'llmsp-'));
    const file = join(dir, 'sp.cjs');
    writeFileSync(file, LLM_SPLIT_PROXY_SCRIPT);
    const ask = async (upstream: string): Promise<string> => {
      const probe = net.createServer();
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((r) => probe.close(() => r()));
      const child = spawn(process.execPath, [file, String(port), upstream, 'api.anthropic.com'], {
        env: { ...process.env, AGENTBOX_RELAY_TOKEN: 'wrong' },
        stdio: 'ignore',
      });
      try {
        for (let i = 0; i < 50; i++) {
          const up = await new Promise<boolean>((r) => {
            const s = net.connect(port, '127.0.0.1', () => (s.end(), r(true)));
            s.on('error', () => r(false));
          });
          if (up) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return await new Promise<string>((resolve) => {
          const s = net.connect(port, '127.0.0.1');
          let buf = '';
          s.on('data', (d) => (buf += d.toString()));
          s.on('close', () => resolve(buf));
          s.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n');
        });
      } finally {
        child.kill();
      }
    };
    const refused = await ask(`127.0.0.1:${String(hubPort)}`);
    expect(refused).toContain('407');
    expect(refused).toContain('bad token');
    const down = await ask(`127.0.0.1:${String(deadPort)}`);
    expect(down).toContain('502 Bad Gateway');
    expect(down).toContain(`hub proxy 127.0.0.1:${String(deadPort)} unreachable`);
    hub.close();
  });
});

describe('resolveLlmProxyRecord', () => {
  const resolve = resolveLlmProxyRecord;
  const cfg = { proxy: 'off' as const, proxyPort: 8790, proxyUrl: '' };

  it('off (config default, or the flag) records nothing', () => {
    expect(resolve('docker', cfg)).toBeUndefined();
    expect(
      resolve('hetzner', { ...cfg, proxy: 'forward', proxyUrl: 'h:1' }, 'off'),
    ).toBeUndefined();
  });
  it('a docker box dials the host relay port', () => {
    expect(resolve('docker', { ...cfg, proxyPort: 18790 }, 'forward')).toEqual({
      mode: 'forward',
      upstream: 'host.docker.internal:18790',
    });
  });
  it('a cloud (and remote-docker) box needs llm.proxyUrl, refused without it', () => {
    expect(() => resolve('hetzner', cfg, 'forward')).toThrow(/needs llm\.proxyUrl/);
    expect(() => resolve('remote-docker', cfg, 'forward')).toThrow(/needs llm\.proxyUrl/);
    expect(
      resolve('vercel', { ...cfg, proxy: 'forward', proxyUrl: 'hub.example.com:8790' }),
    ).toEqual({
      mode: 'forward',
      upstream: 'hub.example.com:8790',
    });
  });
  it('tolerates a scheme / trailing slash, refuses anything not host:port', () => {
    expect(
      resolve('e2b', { ...cfg, proxyUrl: 'http://hub.example.com:8790/' }, 'forward')?.upstream,
    ).toBe('hub.example.com:8790');
    expect(() => resolve('e2b', { ...cfg, proxyUrl: 'hub.example.com' }, 'forward')).toThrow(
      /host:port/,
    );
  });
});
