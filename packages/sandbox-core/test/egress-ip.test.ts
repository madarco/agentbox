import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectEgressCidr,
  detectEgressIp,
  getOverIpv4,
  isIpv4,
  type EgressProbeGet,
} from '../src/egress-ip.js';

function fakeGet(map: Record<string, { status: number; body: string }>): EgressProbeGet {
  return (url) => {
    const r = map[url];
    if (!r) return Promise.reject(new Error(`no fake for ${url}`));
    return Promise.resolve(r);
  };
}

describe('isIpv4', () => {
  it('accepts dotted quads in range and rejects everything else', () => {
    expect(isIpv4('203.0.113.42')).toBe(true);
    expect(isIpv4('0.0.0.0')).toBe(true);
    expect(isIpv4('999.0.0.1')).toBe(false);
    expect(isIpv4('2001:db8::1')).toBe(false);
    expect(isIpv4('::ffff:203.0.113.42')).toBe(false);
    expect(isIpv4('')).toBe(false);
  });
});

describe('detectEgressIp', () => {
  it('returns the IPv4 from the first probe that succeeds', async () => {
    const ip = await detectEgressIp({
      probes: ['https://probe-a', 'https://probe-b'],
      get: fakeGet({
        'https://probe-a': { status: 200, body: '203.0.113.42\n' },
        'https://probe-b': { status: 500, body: 'down' },
      }),
    });
    expect(ip).toBe('203.0.113.42');
  });

  it('falls through garbage and out-of-range answers', async () => {
    const ip = await detectEgressIp({
      probes: ['https://probe-a', 'https://probe-b', 'https://probe-c'],
      get: fakeGet({
        'https://probe-a': { status: 200, body: 'not an ip' },
        'https://probe-b': { status: 200, body: '999.0.0.1' },
        'https://probe-c': { status: 200, body: '198.51.100.7' },
      }),
    });
    expect(ip).toBe('198.51.100.7');
  });

  it('skips an IPv6 answer and keeps probing for the IPv4 egress', async () => {
    const ip = await detectEgressIp({
      probes: ['https://probe-a', 'https://probe-b'],
      get: fakeGet({
        'https://probe-a': { status: 200, body: '2001:db8::42\n' },
        'https://probe-b': { status: 200, body: '198.51.100.7' },
      }),
    });
    expect(ip).toBe('198.51.100.7');
  });

  it('throws a clear error (never a /32 on an IPv6) when only IPv6 comes back', async () => {
    const err = await detectEgressCidr({
      probes: ['https://probe-a', 'https://probe-b'],
      get: fakeGet({
        'https://probe-a': { status: 200, body: '2001:db8::42' },
        'https://probe-b': { status: 200, body: '2001:db8::43' },
      }),
      overrideHint: 'Override with SOME_ENV=<cidr>.',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/could not auto-detect the host's IPv4 egress/);
    expect(msg).toMatch(/probe-a: answered with a non-IPv4 address \(2001:db8::42\)/);
    expect(msg).toMatch(/Override with SOME_ENV=<cidr>\./);
  });

  it('fails loud when every probe fails (no 0.0.0.0/0 silent default)', async () => {
    await expect(
      detectEgressIp({
        probes: ['https://probe-a', 'https://probe-b'],
        get: fakeGet({
          'https://probe-a': { status: 500, body: 'nope' },
          'https://probe-b': { status: 502, body: 'down' },
        }),
      }),
    ).rejects.toThrow(/could not auto-detect.*\n.*HTTP 500/);
  });
});

describe('detectEgressCidr', () => {
  it('composes a /32 from the detected IPv4', async () => {
    const cidr = await detectEgressCidr({
      probes: ['https://probe-a'],
      get: fakeGet({ 'https://probe-a': { status: 200, body: '203.0.113.42' } }),
    });
    expect(cidr).toBe('203.0.113.42/32');
  });
});

describe('getOverIpv4', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  function listen(host: string): Promise<number | null> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        res.end(req.socket.remoteAddress ?? '');
      });
      s.once('error', () => resolve(null));
      s.listen(0, host, () => {
        servers.push(s);
        resolve((s.address() as AddressInfo).port);
      });
    });
  }

  it('connects over IPv4 and returns status + body', async () => {
    const port = await listen('127.0.0.1');
    expect(port).not.toBeNull();
    const res = await getOverIpv4(`http://localhost:${String(port)}/`, 2000);
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it('never dials an IPv6 address, even when the name resolves to one', async (ctx) => {
    // A server on ::1 only: an IPv6-capable client resolving `localhost` to ::1
    // would reach it. The IPv4-pinned probe must not.
    const port = await listen('::1');
    if (port === null) ctx.skip(); // no IPv6 loopback in this environment
    await expect(getOverIpv4(`http://localhost:${String(port)}/`, 2000)).rejects.toThrow();
  });
});
