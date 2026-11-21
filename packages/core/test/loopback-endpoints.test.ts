import { describe, expect, it } from 'vitest';
import {
  findLoopbackEndpoints,
  isLoopbackUrl,
  rewriteLoopbackInJsonText,
  rewriteLoopbackUrl,
  stripJsonComments,
} from '../src/loopback-endpoints.js';

describe('isLoopbackUrl', () => {
  it.each([
    'http://127.0.0.1:4000/v1',
    'http://localhost:11434',
    'https://LOCALHOST/v1',
    'http://127.1.2.3:8080',
    'http://[::1]:4000/v1',
    'http://0.0.0.0:4000',
    'http://user:pw@127.0.0.1:4000/v1',
  ])('%s is loopback', (url) => expect(isLoopbackUrl(url)).toBe(true));

  it.each([
    'https://api.openai.com/v1',
    'http://host.docker.internal:4000',
    'http://192.168.1.5:4000',
    'http://localhost.example.com',
    'ws://127.0.0.1:4000',
    'not a url',
    '',
  ])('%s is not loopback', (url) => expect(isLoopbackUrl(url)).toBe(false));
});

describe('rewriteLoopbackUrl', () => {
  it('swaps only the host, keeping scheme, userinfo, port, path and the absence of a trailing slash', () => {
    expect(rewriteLoopbackUrl('http://127.0.0.1:4000/v1', 'h')).toBe('http://h:4000/v1');
    expect(rewriteLoopbackUrl('http://localhost:4000', 'h')).toBe('http://h:4000');
    expect(rewriteLoopbackUrl('https://u:p@[::1]/x?y=1', 'h')).toBe('https://u:p@h/x?y=1');
    expect(rewriteLoopbackUrl('https://api.example.com', 'h')).toBeNull();
  });
});

describe('findLoopbackEndpoints', () => {
  it('matches only the declared paths, with * wildcards, and reports the effective port', () => {
    const cfg = {
      model_providers: {
        gw: { base_url: 'http://127.0.0.1:4000/v1' },
        tls: { base_url: 'https://localhost/v1' },
        remote: { base_url: 'https://api.example.com/v1' },
      },
      other: { base_url: 'http://127.0.0.1:9/v1' },
    };
    const found = findLoopbackEndpoints(cfg, {
      paths: [['model_providers', '*', 'base_url']],
      source: 'cfg',
    });
    expect(found).toEqual([
      { where: 'cfg model_providers.gw.base_url', url: 'http://127.0.0.1:4000/v1', port: 4000 },
      { where: 'cfg model_providers.tls.base_url', url: 'https://localhost/v1', port: 443 },
    ]);
    // report-only leaves the object alone
    expect(cfg.model_providers.gw.base_url).toBe('http://127.0.0.1:4000/v1');
  });

  it('rewrites in place when a host is given', () => {
    const cfg = { providers: { a: { models: [{ baseUrl: 'http://localhost:1234' }] } } };
    const found = findLoopbackEndpoints(cfg, {
      paths: [['providers', '*', 'models', '*', 'baseUrl']],
      source: 's',
      rewriteHost: 'h',
    });
    expect(cfg.providers.a.models[0]?.baseUrl).toBe('http://h:1234');
    expect(found[0]?.rewrittenTo).toBe('http://h:1234');
  });
});

describe('rewriteLoopbackInJsonText', () => {
  const paths = [['provider', '*', 'options', 'baseURL']] as const;

  it('keeps comments and formatting in JSONC, replacing only the URL literal', () => {
    const text = [
      '{',
      '  // local gateway',
      '  "provider": {',
      '    "gw": { "options": { "baseURL": "http://127.0.0.1:4000/v1" } }, /* trailing */',
      '  },',
      '}',
    ].join('\n');
    const r = rewriteLoopbackInJsonText(text, { paths, source: 'f', rewriteHost: 'h' });
    expect(r.changed).toBe(true);
    expect(r.text).toBe(text.replace('127.0.0.1', 'h'));
    expect(r.endpoints).toHaveLength(1);
  });

  it('is a no-op without a rewrite host, still reporting', () => {
    const text = '{"provider":{"gw":{"options":{"baseURL":"http://localhost:4000"}}}}';
    const r = rewriteLoopbackInJsonText(text, { paths, source: 'f' });
    expect(r).toMatchObject({ text, changed: false });
    expect(r.endpoints[0]?.url).toBe('http://localhost:4000');
  });

  it('throws on unparseable input', () => {
    expect(() => rewriteLoopbackInJsonText('{nope', { paths, source: 'f' })).toThrow();
  });
});

describe('stripJsonComments', () => {
  it('leaves comment markers inside strings alone', () => {
    const text = '{"u": "http://x//y", "c": "/* no */"} // yes';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ u: 'http://x//y', c: '/* no */' });
  });
});
