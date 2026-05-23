import { describe, expect, it } from 'vitest';
import { daytonaProvider } from '../src/index.js';

describe('@agentbox/sandbox-daytona', () => {
  it("exposes a Provider whose name is 'daytona'", () => {
    expect(daytonaProvider.name).toBe('daytona');
  });

  it('declares the core Provider methods', () => {
    expect(typeof daytonaProvider.create).toBe('function');
    expect(typeof daytonaProvider.start).toBe('function');
    expect(typeof daytonaProvider.stop).toBe('function');
    expect(typeof daytonaProvider.destroy).toBe('function');
    expect(typeof daytonaProvider.probeState).toBe('function');
    expect(typeof daytonaProvider.exec).toBe('function');
    expect(typeof daytonaProvider.resolveUrl).toBe('function');
  });
});
