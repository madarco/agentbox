import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord, Provider } from '@agentbox/core';

/**
 * The VNC desktop's browser runs INSIDE the box, so it needs a URL that
 * resolves there.
 *
 * `<box>.localhost` works in both places — the in-box portless mirror serves the
 * same name. A literal `127.0.0.1:<port>` does not: that is an `ssh -L` forward
 * living on the HOST. A box whose agent refuses proxied requests has no portless
 * alias, so its resolved URL is exactly that raw tunnel, and handing it to the
 * in-box browser opens a connection-refused page.
 */
const status = {
  schema: 1,
  boxId: 'b1',
  timestamp: '2026-09-06T00:00:00.000Z',
  services: [{ name: 'openclaw', state: 'ready', port: null, expose: { port: 18789, as: 80 } }],
  tasks: [],
  ports: [],
};

vi.mock('@agentbox/sandbox-docker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbox/sandbox-docker')>();
  return {
    ...actual,
    readBoxStatus: () => Promise.resolve(status),
    desktopOpenCommand: (url: string) => `open ${url}`,
  };
});

const { openWebAppOnVncScreen } = await import('../src/vnc-browser.js');

const box = { id: 'b1', name: 'clawhz' } as BoxRecord;

function providerReturning(url: string): { provider: Provider; opened: string[] } {
  const opened: string[] = [];
  const provider = {
    resolveUrl: () => Promise.resolve(url),
    exec: (_b: BoxRecord, argv: string[]) => {
      opened.push(argv[2] ?? '');
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
  } as unknown as Provider;
  return { provider, opened };
}

describe('openWebAppOnVncScreen target', () => {
  it('swaps a host ssh-forward URL for the service port the box can reach', async () => {
    const { provider, opened } = providerReturning('http://127.0.0.1:59173');
    const r = await openWebAppOnVncScreen(box, provider);
    expect(r.opened).toBe(true);
    expect(r.target).toBe('http://localhost:18789');
    expect(opened[0]).toContain('http://localhost:18789');
  });

  it('keeps a portless URL, which the in-box mirror serves under the same name', async () => {
    const { provider } = providerReturning('https://clawhz.localhost');
    expect((await openWebAppOnVncScreen(box, provider)).target).toBe('https://clawhz.localhost');
  });

  it('keeps a public preview URL the box can reach directly', async () => {
    const { provider } = providerReturning('https://8080-sb1.e2b.app');
    expect((await openWebAppOnVncScreen(box, provider)).target).toBe('https://8080-sb1.e2b.app');
  });
});
