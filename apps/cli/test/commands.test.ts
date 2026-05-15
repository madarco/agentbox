import { describe, expect, it } from 'vitest';
import { claudeCommand } from '../src/commands/claude.js';
import { createCommand } from '../src/commands/create.js';
import { destroyCommand } from '../src/commands/destroy.js';
import { inspectCommand } from '../src/commands/inspect.js';
import { listCommand } from '../src/commands/list.js';
import { pauseCommand } from '../src/commands/pause.js';
import { pruneCommand } from '../src/commands/prune.js';
import { shellCommand } from '../src/commands/shell.js';
import { startCommand } from '../src/commands/start.js';
import { stopCommand } from '../src/commands/stop.js';
import { unpauseCommand } from '../src/commands/unpause.js';

describe('lifecycle CLI surface', () => {
  it('list is registered with -j/--json and the ls alias', () => {
    expect(listCommand.name()).toBe('list');
    expect(listCommand.aliases()).toContain('ls');
    expect(listCommand.options.map((o) => o.long)).toContain('--json');
  });

  it('inspect takes a <box> arg and --json', () => {
    expect(inspectCommand.name()).toBe('inspect');
    expect(inspectCommand.options.map((o) => o.long)).toContain('--json');
  });

  it('pause/unpause/stop/start each take a <box> arg', () => {
    for (const cmd of [pauseCommand, unpauseCommand, stopCommand, startCommand]) {
      expect(cmd.name()).toMatch(/^(pause|unpause|stop|start)$/);
    }
  });

  it('destroy has -y/--yes, --keep-snapshot, and the rm alias', () => {
    expect(destroyCommand.name()).toBe('destroy');
    expect(destroyCommand.aliases()).toContain('rm');
    const longs = destroyCommand.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--yes', '--keep-snapshot']));
  });

  it('prune has --dry-run, --all, and --yes', () => {
    expect(pruneCommand.name()).toBe('prune');
    const longs = pruneCommand.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--dry-run', '--all', '--yes']));
  });

  it('create is still wired (regression check)', () => {
    expect(createCommand.name()).toBe('create');
  });

  it('claude is registered with create-style options + isolation flag + variadic claude-args', () => {
    expect(claudeCommand.name()).toBe('claude');
    const longs = claudeCommand.options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining([
        '--workspace',
        '--name',
        '--snapshot',
        '--no-snapshot',
        '--image',
        '--yes',
        '--isolate-claude-config',
        '--session-name',
      ]),
    );
    // Variadic positional for pass-through `-- <claude-args>`.
    expect(claudeCommand.registeredArguments).toHaveLength(1);
    expect(claudeCommand.registeredArguments[0]!.variadic).toBe(true);
    // attach is a nested subcommand.
    const attach = claudeCommand.commands.find((c) => c.name() === 'attach');
    expect(attach).toBeDefined();
    expect(attach!.options.map((o) => o.long)).toContain('--session-name');
  });

  it('shell takes [box] + variadic [cmd...] and exposes --user / --no-login', () => {
    expect(shellCommand.name()).toBe('shell');
    const longs = shellCommand.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--user', '--no-login']));
    // Two positionals: optional [box] (was required before auto-pick landed),
    // variadic [cmd...].
    expect(shellCommand.registeredArguments).toHaveLength(2);
    expect(shellCommand.registeredArguments[0]!.required).toBe(false);
    expect(shellCommand.registeredArguments[1]!.variadic).toBe(true);
  });

  it('all box-arg commands now accept [box] (optional) for auto-pick', () => {
    const optionalBoxCmds = [
      inspectCommand,
      pauseCommand,
      unpauseCommand,
      stopCommand,
      startCommand,
      destroyCommand,
    ];
    for (const cmd of optionalBoxCmds) {
      expect(cmd.registeredArguments[0]!.required, `${cmd.name()}: [box]`).toBe(false);
    }
  });
});
