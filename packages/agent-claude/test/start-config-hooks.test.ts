import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from '@agentbox/sandbox-docker';

/**
 * On a box created for another agent, `claude start` syncs into a staging
 * volume that is then mirrored (with deletion) into the container. The plugin
 * native-deps rebuild writes node_modules INSIDE the container, so it has to
 * run after that mirror or the mirror deletes its work; the credential mirror
 * writes the volume, so it has to run before.
 */
const io = vi.hoisted(() => ({ credentials: vi.fn(), rebuild: vi.fn() }));
vi.mock('@agentbox/sandbox-docker', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  syncClaudeCredentials: io.credentials,
}));
vi.mock('../src/docker-sync.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  rebuildPluginNativeDeps: io.rebuild,
}));

const { claudeCliSpec } = await import('../src/cli/cli-spec.js');

const box = { container: 'c1', image: 'img' } as BoxRecord;
const message = vi.fn();

beforeEach(() => {
  io.credentials.mockReset().mockResolvedValue({ direction: 'noop' });
  io.rebuild.mockReset().mockResolvedValue({ prunedBytes: 0, pruned: [], failed: [] });
});

describe('claude start hooks', () => {
  it('afterVolumeSync writes credentials through the volume and leaves the container alone', async () => {
    await claudeCliSpec.hooks!.afterVolumeSync!(box, { volume: 'stage-vol', message });
    expect(io.credentials).toHaveBeenCalledWith(
      { volume: 'stage-vol' },
      { image: 'img', isolate: true },
    );
    expect(io.rebuild).not.toHaveBeenCalled();
  });

  it('afterConfigSync rebuilds in the container, prescanning only a mounted volume', async () => {
    await claudeCliSpec.hooks!.afterConfigSync!(box, { message });
    expect(io.rebuild).toHaveBeenCalledWith('c1', {
      volume: undefined,
      onProgress: expect.any(Function),
    });
    expect(io.credentials).not.toHaveBeenCalled();
  });
});
