import { afterEach, describe, expect, it } from 'vitest';
import { hostOpenCommand } from '../src/host-open.js';

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
