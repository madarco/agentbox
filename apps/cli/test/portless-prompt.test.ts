import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybePromptPortless, resolvePortlessNonInteractive } from '../src/portless-prompt.js';

// Mock the two side-effecting dependencies so the test stays pure (no docker,
// no config write, no network) — we only assert the decision logic. Partial mock
// (spread the real module): a wholesale factory undefines every other
// @agentbox/config export for the whole graph, so it breaks the moment some
// transitive import needs one (e.g. STATE_DIR).
vi.mock('@agentbox/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/config')>()),
  setConfigValue: vi.fn(async () => {}),
}));

const proxyRunning = { value: false };
vi.mock('@agentbox/sandbox-docker', () => ({
  detectPortless: vi.fn(async () => ({ installed: true, proxyRunning: proxyRunning.value })),
  installPortless: vi.fn(),
  portlessInstallHint: () => '',
  portlessStartHint: () => '',
  resetPortlessCache: vi.fn(),
  startPortlessProxy: vi.fn(),
  startPortlessProxyRoot: vi.fn(),
}));

const { setConfigValue } = (await import('@agentbox/config')) as unknown as {
  setConfigValue: ReturnType<typeof vi.fn>;
};
const { detectPortless } = (await import('@agentbox/sandbox-docker')) as unknown as {
  detectPortless: ReturnType<typeof vi.fn>;
};

const ORIG_TTY = process.stdin.isTTY;

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: ORIG_TTY, configurable: true });
  proxyRunning.value = false;
  vi.clearAllMocks();
});

function setTTY(v: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
}

const base = { engine: 'docker-desktop' as const, enabled: undefined, yes: false, cwd: '/tmp' };

describe('maybePromptPortless non-interactive path (tray app / --yes)', () => {
  it('adopts an already-running proxy when there is no TTY (the tray-app bug)', async () => {
    setTTY(false);
    proxyRunning.value = true;

    const enabled = await maybePromptPortless(base);

    expect(enabled).toBe(true);
    expect(detectPortless).toHaveBeenCalled();
    // Persisted so later runs skip re-detection, mirroring an interactive "yes".
    expect(setConfigValue).toHaveBeenCalledWith(
      'global',
      'portless.enabled',
      true,
      '/tmp',
      expect.anything(),
    );
  });

  it('returns false and does not persist when no proxy is running', async () => {
    setTTY(false);
    proxyRunning.value = false;

    const enabled = await maybePromptPortless(base);

    expect(enabled).toBe(false);
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it('adopts a running proxy under --yes even with a TTY', async () => {
    setTTY(true);
    proxyRunning.value = true;

    const enabled = await maybePromptPortless({ ...base, yes: true });

    expect(enabled).toBe(true);
  });

  it('short-circuits to the already-decided value without detecting', async () => {
    setTTY(false);
    proxyRunning.value = true;

    const enabled = await maybePromptPortless({ ...base, enabled: false });

    expect(enabled).toBe(false);
    expect(detectPortless).not.toHaveBeenCalled();
  });

  it('stays off for OrbStack (already has .orb.local)', async () => {
    setTTY(false);
    proxyRunning.value = true;

    const enabled = await maybePromptPortless({ ...base, engine: 'orbstack' });

    expect(enabled).toBe(false);
    expect(detectPortless).not.toHaveBeenCalled();
  });
});

// The tray app creates boxes via hub → queue worker, which never calls
// maybePromptPortless; it resolves through resolvePortlessNonInteractive.
describe('resolvePortlessNonInteractive (queue worker / hub-create path)', () => {
  const wargs = { engine: 'docker-desktop' as const, enabled: undefined, cwd: '/tmp' };

  it('adopts and persists an already-running proxy', async () => {
    proxyRunning.value = true;

    const enabled = await resolvePortlessNonInteractive(wargs);

    expect(enabled).toBe(true);
    expect(setConfigValue).toHaveBeenCalledWith(
      'global',
      'portless.enabled',
      true,
      '/tmp',
      expect.anything(),
    );
  });

  it('returns false without persisting when no proxy is running', async () => {
    proxyRunning.value = false;

    const enabled = await resolvePortlessNonInteractive(wargs);

    expect(enabled).toBe(false);
    expect(setConfigValue).not.toHaveBeenCalled();
  });

  it('honors an explicit config value without detecting', async () => {
    proxyRunning.value = true;

    expect(await resolvePortlessNonInteractive({ ...wargs, enabled: false })).toBe(false);
    expect(detectPortless).not.toHaveBeenCalled();
  });

  it('stays off for OrbStack even with a live proxy', async () => {
    proxyRunning.value = true;

    expect(await resolvePortlessNonInteractive({ ...wargs, engine: 'orbstack' })).toBe(false);
    expect(detectPortless).not.toHaveBeenCalled();
  });
});
