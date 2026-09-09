import { afterEach, describe, expect, it } from 'vitest';
import { hostOpenCommand, openOnHost } from '../src/host-open.js';

describe('hostOpenCommand', () => {
  const original = process.platform;
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  afterEach(() => setPlatform(original));

  it('uses xdg-open on Linux', () => {
    setPlatform('linux');
    expect(hostOpenCommand()).toBe('xdg-open');
  });

  it('uses open on macOS', () => {
    setPlatform('darwin');
    expect(hostOpenCommand()).toBe('open');
  });

  it('falls back to open on other platforms', () => {
    setPlatform('win32');
    expect(hostOpenCommand()).toBe('open');
  });
});

describe('openOnHost', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('survives a host with no URL opener', async () => {
    // `spawn` reports a missing binary as an ASYNC 'error' event, not a throw,
    // and an unlistened 'error' on a ChildProcess is re-thrown — which would
    // kill the relay daemon on any Linux host without xdg-open. A try/catch
    // alone does not cover this, hence the test.
    process.env.PATH = '';
    expect(() => openOnHost('https://example.test')).not.toThrow();
    // Let the failed spawn's error event fire before the test ends.
    await new Promise((r) => setTimeout(r, 50));
  });
});
