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

  it('carries the restore flags, and says the state half is not its job', () => {
    const flags = createCommand.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--restore', '--stamp', '--into', '--force']));
    // An agentless box has no agent config volume to restore into, and a user
    // who reads only the help must not expect their bot's identity back here.
    const restore = createCommand.options.find((o) => o.long === '--restore');
    expect(restore?.description).toMatch(/state dir is NOT restored here/);
  });
});
