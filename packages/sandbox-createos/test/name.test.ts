import { describe, expect, it } from 'vitest';

import { createosSandboxName } from '../src/backend.js';

describe('createosSandboxName', () => {
  it('leaves names within the CreateOS limit unchanged', () => {
    expect(createosSandboxName('createos-command-final')).toBe('createos-command-final');
  });

  it('shortens generated names while preserving the unique box id', () => {
    expect(createosSandboxName('agentbox-marketing-b12345678')).toBe('agentbox-mar-b12345678');
  });

  it('adds a stable unique suffix to long custom names', () => {
    const first = createosSandboxName('a-custom-sandbox-name-that-is-too-long');
    const again = createosSandboxName('a-custom-sandbox-name-that-is-too-long');
    const other = createosSandboxName('another-custom-sandbox-name-that-is-too-long');

    expect(first).toHaveLength(22);
    expect(first).toBe(again);
    expect(first).not.toBe(other);
  });
});
