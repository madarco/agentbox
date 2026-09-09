import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Redirect HOME before importing the command module — apps/cli tests share the
// real home otherwise, and anything that touches ~/.agentbox at import time
// would reach the user's actual state.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-list-web-home-'));
process.env['HOME'] = TEST_HOME;

const { webLinkTarget } = await import('../src/commands/list.js');
type Args = Parameters<typeof webLinkTarget>;

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

const LOCAL: Args[1] = { url: 'http://127.0.0.1:8787', apiKey: 'tok en', mode: 'local' };
const REMOTE: Args[1] = { url: 'https://hub.example.com/', apiKey: 'api-key', mode: 'remote' };

const WEB = 'http://127.0.0.1:54449';

function box(over: Partial<Args[0]> = {}): Args[0] {
  return {
    id: 'b1',
    name: 'smoke',
    provider: 'hetzner',
    status: 'running',
    state: 'running',
    webUrl: WEB,
    ...over,
  } as Args[0];
}

describe('webLinkTarget', () => {
  it('leaves a TUI agent`s box on its direct URL', () => {
    // Nothing to resolve and no token to add — the recorded URL IS the answer.
    expect(webLinkTarget(box({ agent: 'claude' }), LOCAL)).toBe(WEB);
    expect(webLinkTarget(box({ agent: 'pi' }), LOCAL)).toBe(WEB);
  });

  it('sends a SERVICE agent through the hub, which resolves live and signs in', () => {
    // The recorded URL carries no sign-in token, and on an SSH-forward provider
    // its port is a snapshot. Both are why this indirection exists.
    expect(webLinkTarget(box({ agent: 'openclaw' }), LOCAL)).toBe(
      'http://127.0.0.1:8787/boxes/b1/web?token=tok%20en',
    );
  });

  it('omits the token on a remote hub, where it buys nothing', () => {
    // Same rule as the VNC link: a password profile gates only /api/v1, so a
    // token in the URL would be a printed secret with no effect.
    expect(webLinkTarget(box({ agent: 'openclaw' }), REMOTE)).toBe(
      'https://hub.example.com/boxes/b1/web',
    );
  });

  it('falls back to the direct URL with no live hub, or a box that is not running', () => {
    // A cached listing has no hub to link into, and the redirect 409s on a box
    // that is not running — either way the direct URL is the better answer.
    expect(webLinkTarget(box({ agent: 'openclaw' }), undefined)).toBe(WEB);
    expect(webLinkTarget(box({ agent: 'openclaw', state: 'paused', status: 'paused' }), LOCAL)).toBe(
      WEB,
    );
  });

  it('is null when the box exposes no web URL at all', () => {
    expect(webLinkTarget(box({ agent: 'openclaw', webUrl: null }), LOCAL)).toBeNull();
    expect(webLinkTarget(box({ agent: 'claude', webUrl: undefined }), LOCAL)).toBeNull();
  });

  it('does not choke on an unknown agent id from a newer hub', () => {
    expect(webLinkTarget(box({ agent: 'not-an-agent' as never }), LOCAL)).toBe(WEB);
    expect(webLinkTarget(box({ agent: undefined }), LOCAL)).toBe(WEB);
  });
});
