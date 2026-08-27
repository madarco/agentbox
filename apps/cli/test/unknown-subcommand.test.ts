import { Command, CommanderError } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { guardDefaultSubcommand, guardDefaultSubcommands } from '../src/lib/unknown-subcommand.js';
import { appCommand } from '../src/commands/app.js';
import { checkpointCommand } from '../src/commands/checkpoint.js';
import { daytonaCommand } from '@agentbox/sandbox-daytona/cli';
import { digitaloceanCommand } from '@agentbox/sandbox-digitalocean/cli';
import { dockerCommand } from '../src/commands/docker.js';
import { e2bCommand } from '@agentbox/sandbox-e2b/cli';
import { hetznerCommand } from '@agentbox/sandbox-hetzner/cli';
import { hubCommand } from '../src/commands/hub.js';
import { relayCommand } from '../src/commands/relay.js';
import { vercelCommand } from '@agentbox/sandbox-vercel/cli';

/** A group shaped like the provider ones: `login` as the arg-less default. */
function buildGroup(): { group: Command; login: ReturnType<typeof vi.fn>; other: Command } {
  const login = vi.fn();
  const loginSub = new Command('login')
    .alias('auth')
    .option('--status', 'show what is configured')
    .action(login);
  const other = new Command('firewall').action(() => {});
  const group = new Command('hetzner').addCommand(loginSub, { isDefault: true }).addCommand(other);
  guardDefaultSubcommand(group);
  return { group, login, other };
}

/** Parse as a user would type it, capturing stderr instead of exiting. */
function run(group: Command, args: string[]): { err: string; error?: CommanderError } {
  let err = '';
  group.exitOverride();
  group.configureOutput({
    writeErr: (s) => {
      err += s;
    },
    writeOut: () => {},
  });
  try {
    group.parse(args, { from: 'user' });
  } catch (e) {
    return { err, error: e as CommanderError };
  }
  return { err };
}

describe('unknown subcommand guard', () => {
  it('rejects an operand that matches no subcommand', () => {
    const { group, login } = buildGroup();
    const { error } = run(group, ['ssh']);
    expect(error).toBeInstanceOf(CommanderError);
    expect(error?.exitCode).toBe(1);
    expect(login).not.toHaveBeenCalled();
  });

  it('names the group and what it accepts', () => {
    const { group } = buildGroup();
    const { err, error } = run(group, ['ssh']);
    expect(error?.code).toBe('commander.unknownCommand');
    expect(err).toContain("unknown command 'ssh' for 'agentbox hetzner'");
    expect(err).toContain('available: login, firewall, create, claude, codex, opencode');
  });

  it('still runs the default subcommand for the bare group', () => {
    const { group, login } = buildGroup();
    run(group, []);
    expect(login).toHaveBeenCalledOnce();
  });

  it('still routes options to the default subcommand', () => {
    const { group, login } = buildGroup();
    run(group, ['--status']);
    expect(login).toHaveBeenCalledOnce();
    expect(login.mock.calls[0]?.[0]).toEqual({ status: true });
  });

  it('leaves an explicit subcommand (or its alias) alone', () => {
    const { group, login } = buildGroup();
    run(group, ['login', '--status']);
    expect(login).toHaveBeenCalledOnce();
    const second = buildGroup();
    run(second.group, ['auth']);
    expect(second.login).toHaveBeenCalledOnce();
  });

  it('passes the operand through when the default takes a positional', () => {
    // `agentbox services <box>` / `agentbox git pr <box>` must keep working.
    const list = vi.fn();
    const group = new Command('services').addCommand(
      new Command('list').argument('[box]', 'box ref').action(list),
      { isDefault: true },
    );
    guardDefaultSubcommand(group);
    run(group, ['mybox']);
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]?.[0]).toBe('mybox');
  });

  it('leaves a group without a default subcommand to commander', () => {
    const group = new Command('remote-docker').addCommand(new Command('add').action(() => {}));
    guardDefaultSubcommand(group);
    expect(run(group, ['bogus']).error?.code).toBe('commander.unknownCommand');
  });
});

describe('registered groups reject unknown subcommands', () => {
  // Mirrors the real registration in src/index.ts. Importing the command
  // modules is side-effect-free (see help.test.ts), and the guard throws before
  // any action runs — so nothing here touches the real ~/.agentbox.
  const groups = [
    daytonaCommand,
    hetznerCommand,
    vercelCommand,
    e2bCommand,
    digitaloceanCommand,
    dockerCommand,
    hubCommand,
    relayCommand,
    appCommand,
    checkpointCommand,
  ];
  const program = new Command();
  for (const g of groups) program.addCommand(g);
  guardDefaultSubcommands(program);

  for (const group of groups) {
    it(`agentbox ${group.name()} bogus errors`, () => {
      let err = '';
      group.exitOverride();
      group.configureOutput({
        writeErr: (s) => {
          err += s;
        },
        writeOut: () => {},
      });
      expect(() => group.parse(['bogus'], { from: 'user' })).toThrow(
        expect.objectContaining({ code: 'commander.unknownCommand' }),
      );
      expect(err).toContain(`unknown command 'bogus' for 'agentbox ${group.name()}'`);
    });
  }
});
