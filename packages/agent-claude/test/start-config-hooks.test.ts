import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxRecord } from '@agentbox/sandbox-docker';
import { claudeCliSpec } from '../src/cli/cli-spec.js';

const io = vi.hoisted(() => ({ credentials: vi.fn(), rebuild: vi.fn() }));
vi.mock('@agentbox/sandbox-docker', async (original) => ({
  ...(await original<typeof import('@agentbox/sandbox-docker')>()),
  syncClaudeCredentials: (...args: unknown[]) => io.credentials(...args),
}));
vi.mock('../src/docker-sync.js', async (original) => ({
  ...(await original<typeof import('../src/docker-sync.js')>()),
  rebuildPluginNativeDeps: (...args: unknown[]) => io.rebuild(...args),
}));

const box = { container: 'test-box', image: 'test-image' } as BoxRecord;
const message = vi.fn();

beforeEach(() => {
  io.credentials.mockReset().mockResolvedValue({ direction: 'noop' });
  io.rebuild.mockReset().mockResolvedValue({ prunedBytes: 0, pruned: [], failed: [] });
});

describe('Claude startup config hooks', () => {
  it('seeds credentials into the temporary volume without rebuilding the stale live tree', async () => {
    await claudeCliSpec.hooks!.afterVolumeSync!(box, { volume: 'temporary-volume', message });
    expect(io.credentials).toHaveBeenCalledWith(
      { volume: 'temporary-volume' },
      { image: 'test-image', isolate: true },
    );
    expect(io.rebuild).not.toHaveBeenCalled();
  });

  it('checks plugins in the live container after copy-back without probing an unrelated shared volume', async () => {
    await claudeCliSpec.hooks!.afterConfigSync!(box, { message });
    expect(io.rebuild).toHaveBeenCalledWith('test-box', {
      volume: undefined,
      onProgress: expect.any(Function),
    });
    expect(io.credentials).not.toHaveBeenCalled();
  });
});
