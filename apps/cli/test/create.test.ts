import { describe, expect, it } from 'vitest';
import { createCommand } from '../src/commands/create.js';

describe('agentbox create command', () => {
  it('is registered with the expected name', () => {
    expect(createCommand.name()).toBe('create');
  });

  it('declares the documented options', () => {
    const flags = createCommand.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        '--workspace',
        '--name',
        '--provider',
        '--snapshot',
        '--image',
        '--attach',
        '--yes',
      ]),
    );
  });

  it('defaults workspace to the current working directory', () => {
    const workspace = createCommand.options.find((o) => o.long === '--workspace');
    expect(workspace?.defaultValue).toBe(process.cwd());
  });
});
