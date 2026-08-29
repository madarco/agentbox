import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for the stale-cache skip.
 *
 * `maybeUpdateTray` used to answer from the <=24h `remoteCheck` snapshot when it
 * was fresh. That made a tray release published within a day of the user's last
 * daily check unreachable via `agentbox self-update`: `bestTrayRelease` was never
 * called, so BOTH the sha and the version came from a snapshot taken before the
 * release existed, and `decideTrayUpdate` compared the installed version against
 * itself and reported "already current".
 */

const SHA_OLD = 'c'.repeat(64);
const SHA_NEW = 'd'.repeat(64);

const bestTrayRelease = vi.fn();
const fetchTraySidecarSha = vi.fn();
const installTray = vi.fn();
const readInstalledTrayVersion = vi.fn();

vi.mock('../src/commands/install-app.js', async (importOriginal) => {
  // Keep the real pure decision functions — the bug was in the inputs handed to
  // them, so stubbing them would test nothing.
  const actual = await importOriginal<typeof import('../src/commands/install-app.js')>();
  return {
    ...actual,
    trayInstalled: () => true,
    trayRunning: () => false,
    restartTray: vi.fn(),
    bestTrayRelease: (...a: unknown[]) => bestTrayRelease(...a),
    fetchTraySidecarSha: (...a: unknown[]) => fetchTraySidecarSha(...a),
    installTray: (...a: unknown[]) => installTray(...a),
    readInstalledTrayVersion: (...a: unknown[]) => readInstalledTrayVersion(...a),
  };
});

vi.mock('../src/lib/update-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/update-state.js')>();
  return {
    ...actual,
    writeUpdateState: vi.fn(),
    // A snapshot taken minutes ago — maximally "fresh", and describing the
    // release the user already has.
    readUpdateState: () => ({
      version: 1 as const,
      traySha: SHA_OLD,
      remoteCheck: {
        checkedAt: new Date().toISOString(),
        trayLatestSha: SHA_OLD,
        trayLatestVersion: '0.1.15',
      },
    }),
  };
});

vi.mock('../src/lib/channel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/channel.js')>();
  return { ...actual, resolveChannel: async () => 'stable' };
});

const { maybeUpdateTray } = await import('../src/lib/post-update-refresh.js');

describe('maybeUpdateTray — never answers from the daily cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readInstalledTrayVersion.mockResolvedValue('0.1.15');
    installTray.mockResolvedValue({ ran: true });
  });

  it('re-resolves the release even when remoteCheck is fresh, and installs the newer build', async () => {
    bestTrayRelease.mockResolvedValue({ tag: 'tray-latest', version: '0.1.16' });
    fetchTraySidecarSha.mockResolvedValue(SHA_NEW);

    const out = await maybeUpdateTray();

    // The whole bug: this call used to be skipped entirely on a fresh cache.
    expect(bestTrayRelease).toHaveBeenCalled();
    expect(installTray).toHaveBeenCalled();
    expect(out.reinstalled).toBe(true);
    expect(out.note).toBe('menu-bar app updated');
  });

  it('still reports current when the live release matches what is installed', async () => {
    bestTrayRelease.mockResolvedValue({ tag: 'tray-latest', version: '0.1.15' });
    fetchTraySidecarSha.mockResolvedValue(SHA_OLD);

    const out = await maybeUpdateTray();

    expect(bestTrayRelease).toHaveBeenCalled();
    expect(installTray).not.toHaveBeenCalled();
    expect(out.note).toBe('menu-bar app already current');
  });

  it('falls back to the cached sha when the live lookup comes back empty (offline)', async () => {
    bestTrayRelease.mockResolvedValue(null);
    fetchTraySidecarSha.mockResolvedValue(undefined);

    const out = await maybeUpdateTray();

    // Cached sha matches the stamp, so an offline refresh must not re-download.
    expect(installTray).not.toHaveBeenCalled();
    expect(out.note).toBe('menu-bar app already current');
  });
});
