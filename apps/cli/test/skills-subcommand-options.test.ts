import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Command } from 'commander';

// Scratch HOME before the imports, like every apps/cli test touching config.
const home = mkdtempSync(join(tmpdir(), 'agentbox-skills-opts-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { skillsCommand } = await import('../src/commands/skills.js');
const { skillsBindingsCommand } = await import('../src/commands/skills-bindings.js');

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

// The real actions call a hub; capture what each would receive instead. This
// file owns its module instance, so replacing the handlers stays local.
let parentOpts: Record<string, unknown> | null = null;
let bindingsOpts: Record<string, unknown> | null = null;
skillsCommand.action((o: Record<string, unknown>) => {
  parentOpts = o;
});
skillsBindingsCommand.action((o: Record<string, unknown>) => {
  bindingsOpts = o;
});

function program(): Command {
  // Same shape as the CLI root (apps/cli/src/index.ts).
  const p = new Command('agentbox').enablePositionalOptions().exitOverride();
  p.addCommand(skillsCommand);
  return p;
}

describe('skills subcommand options', () => {
  it('hands --json to `skills bindings`, not to the parent', async () => {
    parentOpts = bindingsOpts = null;
    await program().parseAsync(['node', 'agentbox', 'skills', 'bindings', '--json']);
    expect(bindingsOpts).toEqual({ json: true });
    expect(parentOpts).toBeNull();
  });

  it('still reads the parent`s own --list --json', async () => {
    parentOpts = bindingsOpts = null;
    await program().parseAsync(['node', 'agentbox', 'skills', '--list', '--json']);
    expect(parentOpts).toMatchObject({ list: true, json: true });
    expect(bindingsOpts).toBeNull();
  });
});
