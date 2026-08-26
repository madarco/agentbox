import { describe, expect, it } from 'vitest';
import { buildNoVncUrl, NOVNC_PORT } from '../src/vnc.js';

describe('buildNoVncUrl', () => {
  it('appends the noVNC path and autoconnect query', () => {
    expect(buildNoVncUrl('https://vnc-box.localhost', 'abc123')).toBe(
      'https://vnc-box.localhost/vnc.html?autoconnect=1&password=abc123',
    );
  });

  it('strips trailing slashes from the base', () => {
    const want = 'http://127.0.0.1:6080/vnc.html?autoconnect=1&password=pw';
    expect(buildNoVncUrl('http://127.0.0.1:6080/', 'pw')).toBe(want);
    expect(buildNoVncUrl('http://127.0.0.1:6080//', 'pw')).toBe(want);
  });

  it('keeps a path prefix on the base', () => {
    expect(buildNoVncUrl('https://host/prefix', 'pw')).toBe(
      'https://host/prefix/vnc.html?autoconnect=1&password=pw',
    );
  });

  it('url-encodes a password with reserved characters', () => {
    const url = buildNoVncUrl('https://host', 'a+b/c&d=e%f');
    expect(url).toContain('password=a%2Bb%2Fc%26d%3De%25f');
    expect(new URL(url).searchParams.get('password')).toBe('a+b/c&d=e%f');
  });

  it('pins the noVNC port the box images serve on', () => {
    expect(NOVNC_PORT).toBe(6080);
  });
});
