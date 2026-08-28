import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `relink` is now the ONLY way a running box learns about a grant change — the
 * 60s poll is gone — so its two failure modes both leave a box wrong in a way
 * nothing else corrects until the daemon restarts:
 *
 *   - skipping the sync when the new list is empty (revoking the last tool), and
 *   - reporting success when the grant list could not be read, which tells the
 *     host "applied" for a box where nothing happened.
 */

const rpc = vi.fn();
const sync = vi.fn();
const list = vi.fn();

vi.mock('../src/relay-rpc.js', () => ({
  postRpcAwait: (...args: unknown[]) => rpc(...args) as unknown,
}));
vi.mock('../src/tool-links.js', () => ({
  syncToolLinks: (...args: unknown[]) => sync(...args) as unknown,
  listToolLinks: (...args: unknown[]) => list(...args) as unknown,
}));

const { ToolLinksWatcher } = await import('../src/tool-links-watcher.js');

function grants(names: string[]): { exitCode: number; stdout: string; stderr: string } {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ tools: names.map((name) => ({ name, bin: name })) }),
    stderr: '',
  };
}

describe('ToolLinksWatcher.relink', () => {
  beforeEach(() => {
    rpc.mockReset();
    sync.mockReset();
    list.mockReset();
    list.mockResolvedValue([]);
    sync.mockResolvedValue({ added: [], removed: [], conflicts: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs when the last tool is revoked (an empty list is a real list)', async () => {
    const w = new ToolLinksWatcher();
    rpc.mockResolvedValueOnce(grants(['jq']));
    await w.relink();
    expect(sync).toHaveBeenCalledWith(['jq'], expect.anything());

    // The revoke: an empty grant list must still reach syncToolLinks, or the
    // shim for the revoked tool stays behind on a box that no longer polls.
    sync.mockClear();
    rpc.mockResolvedValueOnce(grants([]));
    await w.relink();
    expect(sync).toHaveBeenCalledWith([], expect.anything());
  });

  it('reports unavailable when the grant list cannot be read', async () => {
    const w = new ToolLinksWatcher();
    rpc.mockResolvedValueOnce({ exitCode: 69, stdout: '', stderr: 'host offline' });
    await expect(w.relink()).resolves.toBe('unavailable');
    // Links are left exactly as they were rather than torn down on a bad read.
    expect(sync).not.toHaveBeenCalled();
  });

  it('reports unavailable on an unparseable payload', async () => {
    const w = new ToolLinksWatcher();
    rpc.mockResolvedValueOnce({ exitCode: 0, stdout: 'not json', stderr: '' });
    await expect(w.relink()).resolves.toBe('unavailable');
    expect(sync).not.toHaveBeenCalled();
  });

  it('re-syncs an unchanged list, because a push means something changed', async () => {
    // A user who deleted a shim by hand, or a box that failed to create one last
    // time, is fixed by the next push — the skip-if-identical shortcut must not
    // apply to an explicit relink.
    const w = new ToolLinksWatcher();
    rpc.mockResolvedValue(grants(['jq']));
    await w.relink();
    sync.mockClear();
    await w.relink();
    expect(sync).toHaveBeenCalledWith(['jq'], expect.anything());
  });
});
