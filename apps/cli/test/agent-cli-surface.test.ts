import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { agentCommandIds, agentCommandEntry } from '../src/agents/commands.js';

/**
 * The golden CLI surface for `agentbox claude|codex|opencode`.
 *
 * `agentCommand()` builds all three from one factory. The factory's whole
 * premise is that the three commands were already the same command, so the
 * thing that has to be proved is the negative: that collapsing them changed
 * NOTHING a user can type. Every flag, short form, default, description and
 * positional argument is in this fixture, so a dropped `--pids-limit`, a
 * silently-renamed `-b`, or a default that flipped from true to undefined
 * fails here rather than in someone's terminal.
 *
 * The fixture was captured from the three hand-written commands BEFORE the
 * factory existed. Regenerating it is therefore a deliberate act, not a repair:
 *
 *   UPDATE_AGENT_CLI_SURFACE=1 pnpm --filter @madarco/agentbox test -- agent-cli-surface
 *
 * and the diff belongs in the PR that intends the surface change.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '_fixtures',
  'agent-cli-surface.json',
);

interface OptionSurface {
  flags: string;
  description: string;
  defaultValue: unknown;
  mandatory: boolean;
  negate: boolean;
}

interface ArgumentSurface {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  defaultValue: unknown;
}

interface CommandSurface {
  name: string;
  aliases: string[];
  description: string;
  arguments: ArgumentSurface[];
  options: OptionSurface[];
  subcommands: CommandSurface[];
}

/**
 * Read commander's own registries rather than the rendered help text: help
 * wraps to `process.stdout.columns`, which differs between a terminal and CI
 * and would make the fixture flap for reasons that have nothing to do with the
 * surface.
 */
function surfaceOf(cmd: Command): CommandSurface {
  return {
    name: cmd.name(),
    aliases: [...cmd.aliases()],
    description: cmd.description(),
    arguments: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      description: a.description,
      required: a.required,
      variadic: a.variadic,
      defaultValue: a.defaultValue ?? null,
    })),
    options: cmd.options.map((o) => ({
      flags: o.flags,
      description: o.description,
      defaultValue: o.defaultValue ?? null,
      mandatory: o.mandatory,
      negate: o.negate,
    })),
    subcommands: cmd.commands.map((c) => surfaceOf(c as Command)),
  };
}

function currentSurface(): Record<string, CommandSurface> {
  const out: Record<string, CommandSurface> = {};
  for (const id of [...agentCommandIds()].sort()) {
    const entry = agentCommandEntry(id);
    if (!entry) throw new Error(`no command entry for '${id}'`);
    out[id] = surfaceOf(entry.command);
  }
  return out;
}

describe('agent CLI surface', () => {
  it('matches the golden fixture captured before the command factory', () => {
    const actual = currentSurface();
    if (process.env['UPDATE_AGENT_CLI_SURFACE'] === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), `missing fixture ${FIXTURE}`).toBe(true);
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, CommandSurface>;
    expect(actual).toEqual(expected);
  });

  it('covers every agent that has a command', () => {
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, CommandSurface>;
    expect(Object.keys(expected).sort()).toEqual([...agentCommandIds()].sort());
  });
});
