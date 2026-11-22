import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { collectRepeatable } from '../src/agents/command/options.js';
import { loginOptions } from '../src/agents/command/login.js';

/**
 * `agentbox <agent>` (create) and `agentbox <agent> login` both declare
 * `--account`, and commander assigns a flag both declare to the PARENT. Phase 3
 * added the parent flag; without reading the merged view, `login --account ci`
 * silently signed in the default account instead (regression caught in review).
 */
function parse(argv: string[]): Record<string, unknown> {
  let seen: Record<string, unknown> = {};
  const parent = new Command('claude').option('--account <name>', 'acct', collectRepeatable);
  const login = new Command('login')
    .option('--account <name>', 'acct')
    .option('--setup-token', 'tok')
    .action(function (this: Command, opts: Record<string, unknown>) {
      seen = loginOptions(this, opts) as Record<string, unknown>;
    });
  parent.addCommand(login);
  parent.parse(argv, { from: 'user' });
  return seen;
}

describe('login reads --account wherever commander put it', () => {
  it('after the subcommand', () => {
    expect(parse(['login', '--account', 'ci', '--setup-token'])).toMatchObject({
      account: 'ci',
      setupToken: true,
    });
  });
  it('no --account is the default login', () => {
    expect(parse(['login'])).not.toHaveProperty('account');
  });
});
