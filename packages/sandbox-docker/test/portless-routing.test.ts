import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hostPortlessCaPath,
  isPortlessBadGateway,
  isPortlessNotFound,
  portlessBrokenRoutes,
  portlessDoctorRow,
  portlessExec,
  portlessRestartHint,
  resetPortlessCmdForTests,
  routedPortlessUrl,
  setPortlessDirectProbeForTests,
  setPortlessReAliasForTests,
  setPortlessRouteProbeForTests,
  type PortlessRouteState,
} from '../src/portless.js';

const HTTPS = { port: 443, tls: true };

/** Re-registrations routedPortlessUrl made (never the real CLI). */
let aliasCalls: Array<[string, number]> = [];
/** Loopback ports that answer a direct connect. */
let livePorts = new Set<number>();

beforeEach(() => {
  aliasCalls = [];
  livePorts = new Set();
  setPortlessReAliasForTests(async (n, p) => {
    aliasCalls.push([n, p]);
    return true;
  });
  setPortlessDirectProbeForTests(async (p) => livePorts.has(p));
});

afterEach(() => {
  setPortlessRouteProbeForTests(null);
  setPortlessReAliasForTests(null);
  setPortlessDirectProbeForTests(null);
});

/** A probe answering from a queue; the last answer sticks. */
function probe(...answers: PortlessRouteState[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => (answers.length > 1 ? answers.shift() : answers[0]) ?? 'routed');
  setPortlessRouteProbeForTests(fn);
  return fn;
}

describe('isPortlessNotFound', () => {
  const h = { 'x-portless': '1' };
  it("recognises Portless's own 404 for this host (0.18 JSON, 0.15 HTML)", () => {
    expect(
      isPortlessNotFound(404, h, '{"error":"not_found","upstream":"a.localhost"}', 'a.localhost'),
    ).toBe(true);
    expect(
      isPortlessNotFound(
        404,
        h,
        '<p>No app registered for <strong>a.localhost</strong>',
        'a.localhost',
      ),
    ).toBe(true);
  });

  it("does not take the app's own 404 behind a route for a missing route", () => {
    // An API app's common 404 body: same error code, no upstream naming this host.
    expect(isPortlessNotFound(404, h, '{"error":"not_found"}', 'a.localhost')).toBe(false);
    expect(
      isPortlessNotFound(404, h, '{"error":"not_found","upstream":"b.localhost"}', 'a.localhost'),
    ).toBe(false);
    expect(isPortlessNotFound(404, h, 'Cannot GET /', 'a.localhost')).toBe(false);
    expect(
      isPortlessNotFound(404, {}, '{"error":"not_found","upstream":"a.localhost"}', 'a.localhost'),
    ).toBe(false);
    expect(
      isPortlessNotFound(502, h, '{"error":"not_found","upstream":"a.localhost"}', 'a.localhost'),
    ).toBe(false);
  });
});

describe('isPortlessBadGateway', () => {
  const h = { 'x-portless': '1' };
  it("recognises Portless's own 502 (0.18 JSON for this host, 0.15 HTML)", () => {
    expect(
      isPortlessBadGateway(
        502,
        h,
        '{"error":"bad_gateway","upstream":"a.localhost"}',
        'a.localhost',
      ),
    ).toBe(true);
    expect(
      isPortlessBadGateway(
        502,
        h,
        '<p class="desc">The target app is not responding. It may have crashed.</p>',
        'a.localhost',
      ),
    ).toBe(true);
  });

  it("does not take an app's own 502 for Portless's", () => {
    expect(isPortlessBadGateway(502, h, 'upstream connect error', 'a.localhost')).toBe(false);
    expect(
      isPortlessBadGateway(
        502,
        h,
        '{"error":"bad_gateway","upstream":"b.localhost"}',
        'a.localhost',
      ),
    ).toBe(false);
    expect(
      isPortlessBadGateway(
        502,
        {},
        '{"error":"bad_gateway","upstream":"a.localhost"}',
        'a.localhost',
      ),
    ).toBe(false);
  });
});

describe('routedPortlessUrl', () => {
  it('hands out the live URL when the proxy routes the hostname', async () => {
    const fn = probe('routed');
    expect(await routedPortlessUrl('a', HTTPS)).toBe('https://a.localhost');
    expect(fn).toHaveBeenCalledWith('a.localhost', HTTPS);
  });

  it('re-registers onto `port` on a Portless 404 and uses the URL when that took', async () => {
    probe('not-routed', 'routed');
    expect(await routedPortlessUrl('p', HTTPS, { port: 50080 })).toBe('https://p.localhost');
    expect(aliasCalls).toEqual([['p', 50080]]);
  });

  it('resolves a port function only when it needs one (a cloud box forward)', async () => {
    probe('routed');
    const resolve = vi.fn(async () => 48080);
    expect(await routedPortlessUrl('cl', HTTPS, { port: resolve })).toBe('https://cl.localhost');
    expect(resolve).not.toHaveBeenCalled();
    probe('not-routed', 'routed');
    expect(await routedPortlessUrl('cl2', HTTPS, { port: resolve })).toBe('https://cl2.localhost');
    expect(aliasCalls).toEqual([['cl2', 48080]]);
  });

  it('asks the proxy once per TTL for a routed hostname', async () => {
    const fn = probe('routed');
    await routedPortlessUrl('cached', HTTPS);
    await routedPortlessUrl('cached', HTTPS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns undefined (loopback) and names the restart when it stays unrouted', async () => {
    probe('not-routed');
    const onWarn = vi.fn();
    expect(await routedPortlessUrl('c', HTTPS, { port: 50081, onWarn })).toBeUndefined();
    expect(aliasCalls).toEqual([['c', 50081]]);
    expect(onWarn.mock.calls[0]?.[0]).toContain('does not route c.localhost');
    expect(onWarn.mock.calls[0]?.[0]).toContain(portlessRestartHint());
    // Once per outage, not once per click.
    await routedPortlessUrl('c', HTTPS, { port: 50081, onWarn });
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("falls back on Portless's 502 when the box's port answers directly (a stale port)", async () => {
    // A restarted box got a new port; the stuck proxy still sends the alias to the old one.
    livePorts.add(50090);
    probe('bad-gateway');
    const onWarn = vi.fn();
    expect(await routedPortlessUrl('st', HTTPS, { port: 50090, onWarn })).toBeUndefined();
    expect(aliasCalls).toEqual([['st', 50090]]);
    expect(onWarn.mock.calls[0]?.[0]).toContain('sends st.localhost to a port it has not reloaded');
  });

  it('warns again when the reason changes (no route, then a stale port)', async () => {
    const onWarn = vi.fn();
    probe('not-routed');
    await routedPortlessUrl('two', HTTPS, { port: 50093, onWarn });
    livePorts.add(50093);
    probe('bad-gateway');
    await routedPortlessUrl('two', HTTPS, { port: 50093, onWarn });
    expect(onWarn).toHaveBeenCalledTimes(2);
    expect(onWarn.mock.calls[1]?.[0]).toContain('a port it has not reloaded');
  });

  it('a stale-port 502 that the re-alias fixes hands out the alias', async () => {
    livePorts.add(50091);
    probe('bad-gateway', 'routed');
    expect(await routedPortlessUrl('st2', HTTPS, { port: 50091 })).toBe('https://st2.localhost');
    expect(aliasCalls).toEqual([['st2', 50091]]);
  });

  it('keeps the alias on a 502 when the app is down too (loopback is no better)', async () => {
    probe('bad-gateway');
    const onWarn = vi.fn();
    expect(await routedPortlessUrl('down', HTTPS, { port: 50092, onWarn })).toBe(
      'https://down.localhost',
    );
    expect(aliasCalls).toEqual([]);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('keeps the alias on an unknown answer, and needs a mode and an alias', async () => {
    probe('unknown');
    expect(await routedPortlessUrl('d', HTTPS)).toBe('https://d.localhost');
    expect(await routedPortlessUrl('d', null)).toBeUndefined();
    expect(await routedPortlessUrl(undefined, HTTPS)).toBeUndefined();
  });

  it('restart hint names the launchd label on macOS and the systemd unit on Linux', () => {
    expect(portlessRestartHint('darwin')).toBe(
      'sudo launchctl kickstart -k system/sh.portless.proxy',
    );
    expect(portlessRestartHint('linux')).toBe('sudo systemctl restart portless.service');
  });
});

describe('hostPortlessCaPath', () => {
  it('names only ca.pem, never the state dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portless-ca-'));
    await writeFile(join(dir, 'ca.pem'), 'cert');
    await writeFile(join(dir, 'ca-key.pem'), 'key');
    expect(await hostPortlessCaPath(dir)).toBe(join(dir, 'ca.pem'));
  });

  it('is null when the host has no CA (a no-TLS proxy)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portless-noca-'));
    expect(await hostPortlessCaPath(dir)).toBeNull();
  });
});

describe('portlessBrokenRoutes (doctor)', () => {
  async function routesDir(routes: unknown[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'portless-routes-'));
    await writeFile(join(dir, 'routes.json'), JSON.stringify(routes));
    return dir;
  }

  it("probes this host's box aliases first, then the newest static routes", async () => {
    // Portless appends: the oldest routes are the ones a stuck proxy still knows.
    const routes = Array.from({ length: 12 }, (_, i) => ({
      hostname: `r${String(i)}.localhost`,
      port: 40000 + i,
      pid: 0,
    }));
    routes.splice(3, 0, { hostname: 'dev.localhost', port: 4000, pid: 4242 });
    const dir = await routesDir(routes);
    const fn = probe('routed');
    await portlessBrokenRoutes(HTTPS, { stateDir: dir, limit: 4, boxAliases: ['r1'] });
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      'r1.localhost',
      'r11.localhost',
      'r10.localhost',
      'r9.localhost',
    ]);
  });

  it('reports a 404, and a 502 whose registered port answers directly', async () => {
    const dir = await routesDir([
      { hostname: 'gone.localhost', port: 50001, pid: 0 },
      { hostname: 'stale.localhost', port: 50002, pid: 0 },
      { hostname: 'down.localhost', port: 50003, pid: 0 },
      { hostname: 'ok.localhost', port: 50004, pid: 0 },
    ]);
    livePorts.add(50002);
    const answers: Record<string, PortlessRouteState> = {
      'gone.localhost': 'not-routed',
      'stale.localhost': 'bad-gateway',
      'down.localhost': 'bad-gateway',
      'ok.localhost': 'routed',
    };
    setPortlessRouteProbeForTests(async (h) => answers[h] ?? 'routed');
    expect((await portlessBrokenRoutes(HTTPS, { stateDir: dir, boxAliases: [] })).sort()).toEqual([
      'gone.localhost',
      'stale.localhost',
    ]);
  });
});

describe('portlessExec with a remembered cli.js and no node on PATH', () => {
  it('runs it under the running Node (its env-node shebang would exit 127)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'portless-home-'));
    const cli = join(home, 'portless', 'dist', 'cli.js');
    await mkdir(join(home, 'portless', 'dist'), { recursive: true });
    await writeFile(
      cli,
      '#!/usr/bin/env node\nconsole.log("v-test " + process.argv.slice(2).join(" "));\n',
    );
    await chmod(cli, 0o755);
    await mkdir(join(home, '.agentbox'), { recursive: true });
    await writeFile(join(home, '.agentbox', 'portless-bin'), `${cli}\n`);
    const realPath = process.env['PATH'];
    const realHome = process.env['HOME'];
    process.env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin'.replace(
      /[^:]+/g,
      (d) => `/nonexistent${d}`,
    );
    process.env['HOME'] = home;
    resetPortlessCmdForTests();
    try {
      const r = await portlessExec(['--version']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('v-test --version');
    } finally {
      process.env['PATH'] = realPath;
      process.env['HOME'] = realHome;
      resetPortlessCmdForTests();
    }
  });
});

describe('portlessDoctorRow, routes not reloading', () => {
  it('warns with the restart command when registered routes are broken', () => {
    const row = portlessDoctorRow(
      { installed: true, proxyRunning: true, version: '0.15.6', mode: HTTPS },
      { installed: true },
      ['web1.localhost', 'vnc-web1.localhost', 'x.localhost'],
    );
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('proxy not reloading routes');
    expect(row.detail).toContain('web1.localhost, vnc-web1.localhost, …');
    expect(row.hint).toContain(portlessRestartHint());
  });

  it('stays ok when every route answers', () => {
    const row = portlessDoctorRow(
      { installed: true, proxyRunning: true, mode: HTTPS },
      { installed: true },
      [],
    );
    expect(row.status).toBe('ok');
  });
});

describe('the real route probe, against a local stand-in proxy', () => {
  it('reads Portless 404 and 502 shapes, including 0.15 with ~150KB before the marker', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      const host = String(req.headers.host);
      res.setHeader('X-Portless', '1');
      if (host === 'gw-old.localhost') {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end(`<style>${'x'.repeat(150_000)}</style><p>The target app may not be running.</p>`);
      } else if (host === 'gw-new.localhost') {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_gateway', upstream: host, message: 'x' }));
      } else if (host === 'routed.localhost') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found"}'); // the app's own 404 behind a route
      } else if (host === 'old.localhost') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end(
          `<style>${'x'.repeat(150_000)}</style><p>No app registered for <strong>${host}</strong>`,
        );
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found', upstream: host, message: 'x' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const mode = { port, tls: false };
    const onWarn = vi.fn();
    try {
      expect(await routedPortlessUrl('routed', mode, { onWarn })).toBe(
        `http://routed.localhost:${String(port)}`,
      );
      expect(await routedPortlessUrl('old', mode, { onWarn })).toBeUndefined();
      expect(await routedPortlessUrl('new', mode, { onWarn })).toBeUndefined();
      // Portless's 502 with the box port answering directly: a stale route.
      livePorts.add(51000);
      expect(await routedPortlessUrl('gw-old', mode, { port: 51000, onWarn })).toBeUndefined();
      expect(await routedPortlessUrl('gw-new', mode, { port: 51000, onWarn })).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
