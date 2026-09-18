import { readFileSync } from 'node:fs';
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

/**
 * A plain `agentbox create` (no `--tasks`) must not fail because the STORE's hub
 * is unreachable. The box is built by the local hub; the session registration is
 * bookkeeping on whichever hub holds the workspaces — with a control box
 * configured, a machine that may well be off. `withHubClient` would print and
 * set `process.exitCode = 1` for it, and with nothing to clear the code the
 * command would report "box ready" and exit 1.
 *
 * Source-level because the call sits inside commander's action; the behaviour is
 * covered end to end by the create smoke.
 */
describe('the local create path', () => {
  const source = readFileSync(
    new URL('../src/commands/create.ts', import.meta.url),
    'utf8',
  ).replace(/\s+/g, ' ');

  it('registers the session through the QUIET hub client', () => {
    expect(source).toContain(
      'withHubClientQuiet(workspaceHub(), (client) => registerCurrentSession(client)',
    );
  });

  it('keeps the task preflight loud, so a bad id still fails the create', () => {
    expect(source).toContain(
      'withHubClient(workspaceHub(), (client) => preflightOrExit(client, projectRoot, taskIds)',
    );
  });
});
