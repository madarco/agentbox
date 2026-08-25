import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bakeRegisteredHost,
  setRemoteHostBaker,
  setRemoteHostSharer,
  shareRegisteredHost,
} from '../src/share-hook.js';

afterEach(() => {
  setRemoteHostSharer(undefined);
  setRemoteHostBaker(undefined);
});

describe('shareRegisteredHost', () => {
  it('is a no-op with no handler installed', async () => {
    await expect(shareRegisteredHost('buildbox')).resolves.toBeUndefined();
  });

  it('passes the alias through', async () => {
    const fn = vi.fn(async () => {});
    setRemoteHostSharer(fn);
    await shareRegisteredHost('buildbox');
    expect(fn).toHaveBeenCalledWith('buildbox');
  });

  it('swallows the handler error — a registered host must not fail the add', async () => {
    setRemoteHostSharer(async () => {
      throw new Error('control box unreachable');
    });
    await expect(shareRegisteredHost('buildbox')).resolves.toBeUndefined();
  });
});

describe('bakeRegisteredHost', () => {
  it('reports false with no handler, so the caller bakes inline', async () => {
    await expect(bakeRegisteredHost('buildbox')).resolves.toBe(false);
  });

  it('reports true once a handler ran', async () => {
    const fn = vi.fn(async () => {});
    setRemoteHostBaker(fn);
    await expect(bakeRegisteredHost('buildbox')).resolves.toBe(true);
    expect(fn).toHaveBeenCalledWith('buildbox');
  });

  it('propagates the handler error — the caller needs the reason to report it', async () => {
    setRemoteHostBaker(async () => {
      throw new Error('the control box has no docker');
    });
    await expect(bakeRegisteredHost('buildbox')).rejects.toThrow('the control box has no docker');
  });

  it('is cleared by passing undefined', async () => {
    setRemoteHostBaker(async () => {});
    setRemoteHostBaker(undefined);
    await expect(bakeRegisteredHost('buildbox')).resolves.toBe(false);
  });
});
