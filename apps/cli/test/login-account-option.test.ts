import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { collectRepeatable } from '../src/agents/command/options.js';
import { namedAccountFlag } from '../src/agents/command/login.js';

/**
 * `agentbox <agent>` (create) declares `--account`, and commander assigns a flag
 * the parent declares to the PARENT. `login` signs in the default account only
 * (named ones moved to `agentbox credentials add`), so it must SEE a typed
 * `--account` to refuse it, never silently sign the default login in.
 */
function parse(argv: string[]): string | undefined {
  let seen: string | undefined;
  const parent = new Command('claude').option('--account <name>', 'acct', collectRepeatable);
  const login = new Command('login').action(function (this: Command) {
    seen = namedAccountFlag(this);
  });
  parent.addCommand(login);
  parent.parse(argv, { from: 'user' });
  return seen;
}

describe('login sees --account wherever commander put it', () => {
  it('after the subcommand', () => {
    expect(parse(['login', '--account', 'ci'])).toBe('ci');
  });
  it('before the subcommand', () => {
    expect(parse(['--account', 'ci', 'login'])).toBe('ci');
  });
  it('no --account is the default login', () => {
    expect(parse(['login'])).toBeUndefined();
  });
});
