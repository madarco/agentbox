import { describe, expect, it } from 'vitest';
import { buildVncUrls, generateVncPassword, VNC_CONTAINER_PORT } from '../src/vnc.js';

describe('generateVncPassword', () => {
  it('returns exactly 8 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVncPassword()).toHaveLength(8);
    }
  });

  it('uses only [A-Za-z0-9]', () => {
    const alphabet = /^[A-Za-z0-9]+$/;
    for (let i = 0; i < 50; i++) {
      expect(generateVncPassword()).toMatch(alphabet);
    }
  });

  it('produces distinct values across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateVncPassword());
    // 50 samples from 62^8 ≈ 218 trillion → collisions are astronomically unlikely.
    expect(seen.size).toBe(50);
  });
});

describe('buildVncUrls', () => {
  const enabledRecord = {
    container: 'agentbox-foo',
    vncEnabled: true,
    vncHostPort: 54321,
    vncContainerPort: VNC_CONTAINER_PORT,
    vncPassword: 'aB3xZ9Q1',
  };

  it('returns {} when VNC is disabled', () => {
    expect(buildVncUrls({ ...enabledRecord, vncEnabled: false }, 'orbstack')).toEqual({});
  });

  it('returns {} when the password is missing (mid-create or stale record)', () => {
    expect(buildVncUrls({ ...enabledRecord, vncPassword: undefined }, 'orbstack')).toEqual({});
  });

  it('produces an orb.local URL on orbstack', () => {
    const urls = buildVncUrls(enabledRecord, 'orbstack');
    expect(urls.orbUrl).toBe(
      'http://agentbox-foo.orb.local:6080/vnc.html?autoconnect=1&password=aB3xZ9Q1',
    );
  });

  it('omits the orb.local URL off orbstack', () => {
    expect(buildVncUrls(enabledRecord, 'docker-desktop').orbUrl).toBeUndefined();
    expect(buildVncUrls(enabledRecord, 'other').orbUrl).toBeUndefined();
  });

  it('produces a loopback URL whenever vncHostPort is known', () => {
    expect(buildVncUrls(enabledRecord, 'orbstack').loopbackUrl).toBe(
      'http://127.0.0.1:54321/vnc.html?autoconnect=1&password=aB3xZ9Q1',
    );
    expect(buildVncUrls(enabledRecord, 'docker-desktop').loopbackUrl).toBe(
      'http://127.0.0.1:54321/vnc.html?autoconnect=1&password=aB3xZ9Q1',
    );
  });

  it('omits the loopback URL when host port is unknown', () => {
    expect(
      buildVncUrls({ ...enabledRecord, vncHostPort: undefined }, 'orbstack').loopbackUrl,
    ).toBeUndefined();
  });

  it('URL-encodes the password so query string special chars stay safe', () => {
    // generateVncPassword sticks to [A-Za-z0-9], but the field is plain text
    // on BoxRecord and could be hand-edited; guard against future breakage.
    const urls = buildVncUrls({ ...enabledRecord, vncPassword: 'a&b=c d' }, 'orbstack');
    expect(urls.orbUrl).toContain('password=a%26b%3Dc%20d');
  });
});
