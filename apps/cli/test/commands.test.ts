import { describe, expect, it } from 'vitest';
import { checkpointCommand } from '../src/commands/checkpoint.js';
import { claudeCommand } from '../src/commands/claude.js';
import { createCommand } from '../src/commands/create.js';
import { destroyCommand } from '../src/commands/destroy.js';
import { statusCommand } from '../src/commands/status.js';
import { runInspect } from '../src/commands/inspect.js';
import { listCommand } from '../src/commands/list.js';
import { openCommand } from '../src/commands/open.js';
import { browserCommand } from '../src/commands/browser.js';
import { screenCommand } from '../src/commands/screen.js';
import { pauseCommand } from '../src/commands/pause.js';
import { pruneCommand } from '../src/commands/prune.js';
import { relayCommand } from '../src/commands/relay.js';
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

  it('status takes a <box> arg, --json, and absorbs inspect via --inspect', () => {
    expect(statusCommand.name()).toBe('status');
    const longs = statusCommand.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--json', '--inspect']));
    expect(statusCommand.registeredArguments[0]!.required).toBe(false);
    // inspect logic retained as a callable function (no top-level command).
    expect(typeof runInspect).toBe('function');
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

  it('open is files-only (Finder + --path), no --browser/--loopback/--upper', () => {
    expect(openCommand.name()).toBe('open');
    expect(openCommand.commands).toHaveLength(0);
    const longs = openCommand.options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(['--no-refresh', '--include-node-modules', '--path', '--print']),
    );
    // --upper retired with the FUSE overlay; the merged export is the only view now.
    expect(longs).not.toContain('--upper');
    expect(longs).not.toContain('--browser');
    expect(longs).not.toContain('--loopback');
  });

  it('browser/screen are separate top-level commands with [box] + --print/--loopback', () => {
    expect(browserCommand.name()).toBe('browser');
    expect(screenCommand.name()).toBe('screen');
    for (const cmd of [browserCommand, screenCommand]) {
      expect(cmd.registeredArguments[0]!.required, `${cmd.name()}: [box]`).toBe(false);
      const longs = cmd.options.map((o) => o.long);
      expect(longs, cmd.name()).toEqual(expect.arrayContaining(['--print', '--loopback']));
    }
  });

  it('relay has status (default) / stop / start / restart subcommands', () => {
    expect(relayCommand.name()).toBe('relay');
    const subs = relayCommand.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(['status', 'stop', 'start', 'restart']));
    const status = relayCommand.commands.find((c) => c.name() === 'status');
    expect(status!.options.map((o) => o.long)).toContain('--json');
  });

  it('checkpoint has create (default) / ls / set-default / rm subcommands', () => {
    expect(checkpointCommand.name()).toBe('checkpoint');
    const subs = checkpointCommand.commands.map((c) => c.name());
    expect(subs).toEqual(expect.arrayContaining(['create', 'ls', 'set-default', 'rm']));
    const create = checkpointCommand.commands.find((c) => c.name() === 'create');
    expect(create!.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--name', '--merged', '--set-default']),
    );
  });

  it('claude is registered with create-style options + isolation flag + variadic claude-args', () => {
    expect(claudeCommand.name()).toBe('claude');
    const longs = claudeCommand.options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining([
        '--workspace',
        '--name',
        '--host-snapshot',
        '--no-host-snapshot',
        '--snapshot',
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
      statusCommand,
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
