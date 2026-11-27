import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isPortlessNotFound,
  hostPortlessCaPath,
  portlessDoctorRow,
  portlessRestartHint,
  portlessUnroutedRoutes,
  routedPortlessUrl,
  setPortlessReAliasForTests,
  setPortlessRouteProbeForTests,
  type PortlessRouteState,
} from '../src/portless.js';

const HTTPS = { port: 443, tls: true };

afterEach(() => {
  setPortlessRouteProbeForTests(null);
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

describe('routedPortlessUrl', () => {
  it('hands out the live URL when the proxy routes the hostname', async () => {
    const fn = probe('routed');
    expect(await routedPortlessUrl('a', HTTPS)).toBe('https://a.localhost');
    expect(fn).toHaveBeenCalledWith('a.localhost', HTTPS);
  });

  it('re-registers onto `port` itself when the caller passes one', async () => {
    probe('not-routed', 'routed');
    const calls: Array<[string, number]> = [];
    setPortlessReAliasForTests(async (n, p) => {
      calls.push([n, p]);
      return true;
    });
    try {
      expect(await routedPortlessUrl('p', HTTPS, { port: 50080 })).toBe('https://p.localhost');
    } finally {
      setPortlessReAliasForTests(null);
    }
    expect(calls).toEqual([['p', 50080]]);
  });

  it('asks the proxy once per TTL for a routed hostname', async () => {
    const fn = probe('routed');
    await routedPortlessUrl('cached', HTTPS);
    await routedPortlessUrl('cached', HTTPS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-aliases once on a Portless 404 and uses the URL when that took', async () => {
    probe('not-routed', 'routed');
    const reAlias = vi.fn(async () => true);
    expect(await routedPortlessUrl('b', { port: 1355, tls: false }, { reAlias })).toBe(
      'http://b.localhost:1355',
    );
    expect(reAlias).toHaveBeenCalledTimes(1);
  });

  it('returns undefined (loopback) and names the restart when it stays unrouted', async () => {
    probe('not-routed');
    const reAlias = vi.fn(async () => true);
    const onWarn = vi.fn();
    expect(await routedPortlessUrl('c', HTTPS, { reAlias, onWarn })).toBeUndefined();
    expect(reAlias).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toContain(portlessRestartHint());
    // Once per outage, not once per click.
    await routedPortlessUrl('c', HTTPS, { reAlias, onWarn });
    expect(onWarn).toHaveBeenCalledTimes(1);
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

describe('portlessUnroutedRoutes', () => {
  it('checks only static aliases (pid 0) from the given state dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portless-routes-'));
    await writeFile(
      join(dir, 'routes.json'),
      JSON.stringify([
        { hostname: 'box1.localhost', port: 50080, pid: 0 },
        { hostname: 'dev.localhost', port: 4000, pid: 4242 },
        { hostname: 'box2.localhost', port: 50081, pid: 0 },
      ]),
    );
    const fn = probe('not-routed', 'routed');
    expect(await portlessUnroutedRoutes(HTTPS, { stateDir: dir })).toEqual(['box1.localhost']);
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['box1.localhost', 'box2.localhost']);
  });
});

describe('portlessDoctorRow, routes not reloading', () => {
  it('warns with the restart command when registered routes get a Portless 404', () => {
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
  it('reads both Portless 404 shapes, including 0.15 with ~150KB before the marker', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      const host = String(req.headers.host);
      res.setHeader('X-Portless', '1');
      if (host === 'routed.localhost') {
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
    } finally {
      server.close();
    }
  });
});
