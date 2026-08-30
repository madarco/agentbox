/**
 * Reject an unrecognised subcommand on a group that has a DEFAULT subcommand.
 *
 * commander dispatches to the default subcommand for any operand it can't match
 * (`_parseCommand`: `_findCommand` first, then the implicit `help`, then the
 * default), and v12 silently drops the excess operand. So `agentbox hetzner ssh`
 * used to run `hetzner login` — a typo turned into a credential prompt — and
 * `agentbox hub bogus` STARTED the hub.
 *
 * `isDefault` should cover the bare `agentbox <group>` case, not
 * `agentbox <group> <anything>`. The guard runs as a `preSubcommand` hook, which
 * fires for both the explicit and the default dispatch; comparing the dispatched
 * command's own name/alias against the group's first operand tells the two apart
 * without reaching into commander internals.
 */

import { isProviderKind } from '@agentbox/config';
import type { Command } from 'commander';
import { sugaredCommands } from '../provider/argv-prefix.js';

/** Everything the group accepts, for the error message. */
function acceptedCommands(group: Command): string[] {
  const own = group
    .createHelp()
    .visibleCommands(group)
    .map((c) => c.name())
    .filter((n) => n !== 'help');
  // A provider group's create/claude/codex/opencode never reach commander — the
  // argv rewriter turns them into `--provider <name>` first — so they are absent
  // from `commands` yet are exactly what a mistyped provider subcommand meant.
  const sugar = isProviderKind(group.name()) ? sugaredCommands() : [];
  return [...own, ...sugar];
}

/** Print `unknown command` naming what the group does accept, and exit 1. */
export function failUnknownSubcommand(group: Command, name: string): never {
  const accepted = acceptedCommands(group);
  const lines = [`error: unknown command '${name}' for 'agentbox ${group.name()}'`];
  if (accepted.length) lines.push(`       available: ${accepted.join(', ')}`);
  lines.push('       (add --help for more information)');
  group.error(lines.join('\n'), { code: 'commander.unknownCommand' });
}

/** Guard one group's default-subcommand fallback. No-op for groups without one. */
export function guardDefaultSubcommand(group: Command): void {
  group.hook('preSubcommand', (thisCommand, actionCommand) => {
    const first = thisCommand.args[0];
    // Nothing to route (bare group), or an option — the default subcommand owns it.
    if (!first || first.startsWith('-')) return;
    // Explicit dispatch: the operand IS this subcommand's name or alias.
    if (first === actionCommand.name() || actionCommand.aliases().includes(first)) return;
    // The default legitimately takes an operand (`services [box]`, `git pr <box>`).
    if (actionCommand.registeredArguments.length > 0) return;
    failUnknownSubcommand(thisCommand, first);
  });
}

/**
 * Install the guard on every registered command group. Safe to apply blindly:
 * with no default subcommand the hook only ever fires on a matching dispatch.
 */
export function guardDefaultSubcommands(program: Command): void {
  for (const cmd of program.commands) guardDefaultSubcommand(cmd);
}
