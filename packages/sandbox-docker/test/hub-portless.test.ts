import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `hub.ts` resolves ~/.agentbox at module load, so HOME has to be redirected
// before the import — hence the hoisted temp dir. Without it these tests would
// read and REWRITE the real user's hub state (this suite has no HOME isolation
// of its own).
const { homeDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return { homeDir: mkdtempSync(j(tmpdir(), 'agentbox-hub-test-')) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeDir };
});

const { detectPortlessMock, portlessGetUrlMock } = vi.hoisted(() => ({
  detectPortlessMock: vi.fn(),
  portlessGetUrlMock: vi.fn(),
}));
vi.mock('../src/portless.js', () => ({
  detectPortless: detectPortlessMock,
  portlessGetUrl: portlessGetUrlMock,
  portlessAlias: vi.fn(async () => true),
  portlessUnalias: vi.fn(async () => true),
}));

// The hub lifecycle moved to sandbox-core (Step 12); getHubStatus consults the
// docker Portless integration through the hub-hooks seam. Register the docker
// hooks so this exercises the real cache-vs-live-proxy logic end-to-end.
const { getHubStatus, setHubPortlessHooks } = await import('@agentbox/sandbox-core');
const { dockerHubPortlessHooks } = await import('../src/hub-portless.js');
setHubPortlessHooks(dockerHubPortlessHooks);

const PORTLESS_FILE = join(homeDir, '.agentbox', 'hub', 'portless-url');

beforeEach(async () => {
  await rm(join(homeDir, '.agentbox'), { recursive: true, force: true });
  await mkdir(join(homeDir, '.agentbox', 'hub'), { recursive: true });
  detectPortlessMock.mockReset();
  portlessGetUrlMock.mockReset();
  // No hub is listening in a unit test; keep the healthz probe off the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('getHubStatus portless URL', () => {
  it('ignores a cached URL when no proxy is running', async () => {
    // The exact shape a reboot leaves behind: the route registry (and so this
    // cache) survives, the proxy does not.
    await writeFile(PORTLESS_FILE, 'https://agentbox.localhost:1355', 'utf8');
    detectPortlessMock.mockResolvedValue({ installed: true, proxyRunning: false });

    const s = await getHubStatus();
    expect(s.hostUrl).toBe(`http://127.0.0.1:${String(s.port)}`);
    expect(portlessGetUrlMock).not.toHaveBeenCalled();
  });

  it('re-resolves the URL instead of trusting the cache', async () => {
    // Cached under the no-root :1355 proxy; the host has since moved to the
    // root :443 one (e.g. `agentbox install portless`), which changes both the
    // scheme and the port.
    await writeFile(PORTLESS_FILE, 'http://agentbox.localhost:1355', 'utf8');
    detectPortlessMock.mockResolvedValue({ installed: true, proxyRunning: true });
    portlessGetUrlMock.mockResolvedValue('https://agentbox.localhost');

    const s = await getHubStatus();
    expect(s.hostUrl).toBe('https://agentbox.localhost');
    expect(await readFile(PORTLESS_FILE, 'utf8')).toBe('https://agentbox.localhost');
  });

  it('stays on loopback when the hub never registered an alias', async () => {
    detectPortlessMock.mockResolvedValue({ installed: true, proxyRunning: true });
    const s = await getHubStatus();
    expect(s.hostUrl).toBe(`http://127.0.0.1:${String(s.port)}`);
    expect(detectPortlessMock).not.toHaveBeenCalled();
  });
});
