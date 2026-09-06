import { describe, expect, it } from 'vitest';
import { mergePreviewUrls } from '../src/preview-urls.js';

/**
 * The bug this pins: hetzner and digitalocean moved their in-box WebProxy off
 * `:80`, and a box created before that heals onto the new port on its next
 * start. The cached map still held `80 -> <old forward>`, and `inspect` reports
 * every non-web entry as a reachable `service-<port>` endpoint — so a healed
 * box published a second URL aimed at the port it had just abandoned, which is
 * the dead one portless owns.
 */
describe('mergePreviewUrls', () => {
  it('drops the port the box moved off', () => {
    const merged = mergePreviewUrls({
      cached: { 80: 'http://127.0.0.1:1111', 3000: 'http://127.0.0.1:2222' },
      fresh: {},
      previousWebPort: 80,
      webPort: 8080,
      webUrl: 'http://127.0.0.1:3333',
    });
    expect(merged[80]).toBeUndefined();
    expect(merged[8080]).toBe('http://127.0.0.1:3333');
    // An unrelated service port is not collateral damage.
    expect(merged[3000]).toBe('http://127.0.0.1:2222');
  });

  it('keeps the web entry when the port did not change', () => {
    const merged = mergePreviewUrls({
      cached: { 8080: 'http://127.0.0.1:1111' },
      fresh: {},
      previousWebPort: 8080,
      webPort: 8080,
      webUrl: 'http://127.0.0.1:9999',
    });
    expect(merged).toEqual({ 8080: 'http://127.0.0.1:9999' });
  });

  it('still drops the old port when the new web URL could not be resolved', () => {
    // Leaving the stale entry as the only web-ish URL would be the worst case:
    // the box would publish exclusively the dead one.
    const merged = mergePreviewUrls({
      cached: { 80: 'http://127.0.0.1:1111' },
      fresh: {},
      previousWebPort: 80,
      webPort: 8080,
      webUrl: undefined,
    });
    expect(merged).toEqual({});
  });

  it('keeps cached entries this start could not re-resolve', () => {
    const merged = mergePreviewUrls({
      cached: { 3000: 'http://127.0.0.1:2222', 9000: 'http://127.0.0.1:4444' },
      fresh: { 3000: 'http://127.0.0.1:5555' },
      previousWebPort: 8080,
      webPort: 8080,
      webUrl: 'http://127.0.0.1:3333',
    });
    expect(merged[3000]).toBe('http://127.0.0.1:5555');
    expect(merged[9000]).toBe('http://127.0.0.1:4444');
  });

  it('is a no-op on a box that has never recorded a web port', () => {
    const merged = mergePreviewUrls({
      cached: undefined,
      fresh: {},
      previousWebPort: undefined,
      webPort: 80,
      webUrl: 'http://127.0.0.1:1111',
    });
    expect(merged).toEqual({ 80: 'http://127.0.0.1:1111' });
  });
});
