import { describe, expect, it } from 'vitest';
import { hetznerBackend } from '../src/backend.js';

/**
 * The box's own portless proxy owns :80.
 *
 * `startInBoxPortless` runs `portless proxy start` inside the VPS so
 * `https://<box>.localhost` resolves the same on the host and in the box. That
 * proxy takes :443 and holds :80 for the http->https redirect, so ctl's
 * WebProxy — which binds the reserved web port — lost the race and logged
 * EADDRINUSE. Nothing failed: the box reported ready and `agentbox url` printed
 * a URL that portless answered with a 302 into a 404.
 *
 * Declaring a non-privileged port moves ctl out of the way; it reaches the box
 * as AGENTBOX_WEB_PROXY_PORT and is also what the in-box `portless alias`
 * points at, so both sides move together.
 */
describe('hetzner webProxyPort', () => {
  it('keeps the in-box forwarder off the port portless owns', () => {
    expect(hetznerBackend.webProxyPort).toBeDefined();
    expect(hetznerBackend.webProxyPort).not.toBe(80);
  });

  it('uses the same port vercel and e2b already use', () => {
    // One in-box convention for every provider that cannot use :80 — the value
    // is baked into docs and into `agentbox shell <box> -- curl :8080`.
    expect(hetznerBackend.webProxyPort).toBe(8080);
  });
});
