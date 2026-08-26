import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Redirect HOME before importing the command module — apps/cli tests share the
// real home otherwise, and anything that touches ~/.agentbox at import time
// would reach the user's actual state.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-list-vnc-home-'));
process.env['HOME'] = TEST_HOME;

const { vncLinkTarget } = await import('../src/commands/list.js');
type Args = Parameters<typeof vncLinkTarget>;

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

const LOCAL: Args[1] = { url: 'http://127.0.0.1:8787', apiKey: 'tok en', mode: 'local' };
const REMOTE: Args[1] = { url: 'https://hub.example.com/', apiKey: 'api-key', mode: 'remote' };

function box(over: Partial<Args[0]> = {}): Args[0] {
  return {
    id: 'b1',
    name: 'smoke',
    provider: 'daytona',
    status: 'running',
    state: 'running',
    vncEnabled: true,
    ...over,
  } as Args[0];
}

describe('vncLinkTarget', () => {
  it('prefers a static payload URL and ignores the hub entirely', () => {
    const b = box({ vncUrl: 'https://vnc-smoke.localhost/vnc.html?autoconnect=1&password=pw' });
    expect(vncLinkTarget(b, LOCAL)).toBe(b.vncUrl);
    expect(vncLinkTarget(b, undefined)).toBe(b.vncUrl);
  });

  it('links a cloud box at the local hub redirect, carrying the token', () => {
    expect(vncLinkTarget(box(), LOCAL)).toBe('http://127.0.0.1:8787/boxes/b1/vnc?token=tok%20en');
  });

  it('omits the token for a remote control box (its key gates only /api/v1)', () => {
    expect(vncLinkTarget(box(), REMOTE)).toBe('https://hub.example.com/boxes/b1/vnc');
  });

  it('url-encodes the box id', () => {
    expect(vncLinkTarget(box({ id: 'a/b?c' }), REMOTE)).toBe(
      'https://hub.example.com/boxes/a%2Fb%3Fc/vnc',
    );
  });

  it('has no link without a live hub (a stale/cached listing)', () => {
    expect(vncLinkTarget(box(), undefined)).toBeNull();
  });

  it('has no link when VNC is off or unknown', () => {
    expect(vncLinkTarget(box({ vncEnabled: false }), LOCAL)).toBeNull();
    expect(vncLinkTarget(box({ vncEnabled: undefined }), LOCAL)).toBeNull();
  });

  it('has no link unless the box is running — a mint would only 409', () => {
    for (const state of ['paused', 'stopped', 'missing'] as const) {
      expect(vncLinkTarget(box({ state, status: state }), LOCAL)).toBeNull();
    }
    // A synthetic in-flight `job:` box carries only `status`.
    expect(vncLinkTarget(box({ state: undefined, status: 'creating' }), LOCAL)).toBeNull();
  });
});
