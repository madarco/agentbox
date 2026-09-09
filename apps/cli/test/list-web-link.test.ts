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

  it('finds the service agent even when lastAgent has been overwritten', () => {
    // `b.agent` is lastAgent: run `agentbox claude` inside an OpenClaw box and
    // it flips to claude while the gateway keeps serving. Reading only that
    // would hand the user an unauthenticated token prompt — which is why
    // `serviceAgentForBox` scans every agent the box knows.
    const b = box({
      agent: 'claude',
      agentStatus: { openclaw: { state: 'idle' }, claude: { state: 'idle' } },
    });
    expect(webLinkTarget(b, LOCAL)).toBe('http://127.0.0.1:8787/boxes/b1/web?token=tok%20en');
  });

  it('leaves a REMOTE hub on the direct URL, which may predate the /web route', () => {
    // `/boxes/:id/web` landed two weeks after `/boxes/:id/vnc`, so a control box
    // deployed in between 404s it — and a printed link cannot catch that the way
    // `agentbox url` does. Direct URL is what a remote hub had before.
    expect(webLinkTarget(box({ agent: 'openclaw' }), REMOTE)).toBe(WEB);
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
