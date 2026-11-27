import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOX_PORTLESS_CA_PATH,
  isPortlessNotFound,
  portlessCaMount,
  portlessDoctorRow,
  portlessRestartHint,
  routedPortlessUrl,
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
  it("recognises Portless's own 404 (0.18 JSON, 0.15 HTML)", () => {
    const h = { 'x-portless': '1' };
    expect(isPortlessNotFound(404, h, '{"error":"not_found","upstream":"a.localhost"}')).toBe(true);
    expect(
      isPortlessNotFound(404, h, '<p>No app registered for <strong>a.localhost</strong>'),
    ).toBe(true);
  });

  it("does not take the app's own 404 behind a route for a missing route", () => {
    expect(isPortlessNotFound(404, { 'x-portless': '1' }, 'Cannot GET /')).toBe(false);
    expect(isPortlessNotFound(404, {}, '{"error":"not_found"}')).toBe(false);
    expect(isPortlessNotFound(502, { 'x-portless': '1' }, '{"error":"not_found"}')).toBe(false);
  });
});

describe('routedPortlessUrl', () => {
  it('hands out the live URL when the proxy routes the hostname', async () => {
    const fn = probe('routed');
    expect(await routedPortlessUrl('a', HTTPS)).toBe('https://a.localhost');
    expect(fn).toHaveBeenCalledWith('a.localhost', HTTPS);
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

describe('portlessCaMount', () => {
  it('shares only ca.pem, read-only, never the state dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portless-ca-'));
    await writeFile(join(dir, 'ca.pem'), 'cert');
    await writeFile(join(dir, 'ca-key.pem'), 'key');
    const spec = await portlessCaMount(dir);
    expect(spec).toBe(`${join(dir, 'ca.pem')}:${BOX_PORTLESS_CA_PATH}:ro`);
    expect(spec?.startsWith(`${dir}:`)).toBe(false);
  });

  it('mounts nothing when the host has no CA (a no-TLS proxy)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portless-noca-'));
    expect(await portlessCaMount(dir)).toBeNull();
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
