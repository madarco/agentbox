import type { BoxRecord } from '@agentbox/core';
import { describe, expect, it } from 'vitest';
import { BoxNotFoundError, dockerProvider } from '../src/index.js';

describe('@agentbox/sandbox-docker', () => {
  it('exposes the docker provider name', () => {
    expect(dockerProvider.name).toBe('docker');
  });

  it('pause/resume/stop/destroy reject unknown boxes with BoxNotFoundError', async () => {
    // Synthetic record whose id isn't in the host state file — the lifecycle
    // helpers reject it once they try to resolve it.
    const ghost: BoxRecord = {
      id: 'does-not-exist',
      name: 'does-not-exist',
      provider: 'docker',
      container: 'agentbox-does-not-exist',
      image: 'agentbox/box:dev',
      workspacePath: '/tmp/ghost',
      createdAt: '2026-05-12T12:00:00.000Z',
    };
    await expect(dockerProvider.pause(ghost)).rejects.toBeInstanceOf(BoxNotFoundError);
    await expect(dockerProvider.resume(ghost)).rejects.toBeInstanceOf(BoxNotFoundError);
    await expect(dockerProvider.stop(ghost)).rejects.toBeInstanceOf(BoxNotFoundError);
    await expect(dockerProvider.destroy(ghost)).rejects.toBeInstanceOf(BoxNotFoundError);
  });
});
