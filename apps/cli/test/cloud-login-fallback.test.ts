import { describe, expect, it, vi } from 'vitest';
import { prepareClaudeLoginHelper } from '../src/lib/queue/cloud-login-fallback.js';

describe('queued Claude login helper', () => {
  it('lets a cloud create continue when the local Docker helper is unavailable', async () => {
    const onFallback = vi.fn();

    await expect(
      prepareClaudeLoginHelper(
        () => Promise.reject(new Error('Docker daemon unavailable')),
        true,
        onFallback,
      ),
    ).resolves.toBe(false);
    expect(onFallback).toHaveBeenCalledWith('Docker daemon unavailable');
  });

  it('keeps Docker create failures fatal', async () => {
    await expect(
      prepareClaudeLoginHelper(
        () => Promise.reject(new Error('Docker daemon unavailable')),
        false,
        () => {},
      ),
    ).rejects.toThrow('Docker daemon unavailable');
  });
});
