import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentIds } from '@agentbox/sandbox-core';
import { describe, expect, it } from 'vitest';

/**
 * The CLI's per-agent DISPATCH maps, checked against the registry.
 *
 * Distinct from `agent-module-table.test.ts`, which covers the module table:
 * these are the maps that decide what actually runs for an agent. With `AgentId`
 * open, each was previously an exhaustive `switch` or an `if/else` the compiler
 * proved total, and widening the type turned a missing arm into a silent
 * fallthrough — `attach` exiting 0 without attaching, `fork` dereferencing
 * undefined. Both now throw, and these assertions are what keep them populated.
 *
 * Read from source rather than imported: `commands/fork.ts` and `attach.ts` pull
 * in all three agent commands and their provider machinery, which is a heavy and
 * side-effectful import for an assertion about a table's keys.
 *
 * These retire with the `agentCommand(spec)` factory, which builds the maps from
 * the registry instead of listing them.
 */
function keysOf(file: string[], literal: RegExp, label: string): string[] {
  const src = readFileSync(join(__dirname, '..', 'src', ...file), 'utf8');
  const block = src.match(literal);
  expect(block, `${label} literal not found — was it renamed?`).not.toBeNull();
  return [...(block![1] ?? '').matchAll(/^\s*([a-z][\w-]*):/gm)].map((m) => m[1]!);
}

describe('per-agent dispatch maps', () => {
  it('fork registers a command for every agent in the registry', () => {
    const keys = keysOf(
      ['commands', 'fork.ts'],
      /const AGENT_COMMAND: Record<string, Command> = \{([^}]*)\}/,
      'AGENT_COMMAND',
    );
    expect(keys.sort()).toEqual([...agentIds()].sort());
  });

  it('attach registers a wrapper for every agent in the registry', () => {
    const keys = keysOf(
      ['commands', 'attach.ts'],
      /const ATTACH_WRAPPED: Record<string, typeof attachClaudeWrapped> = \{([^}]*)\}/,
      'ATTACH_WRAPPED',
    );
    expect(keys.sort()).toEqual([...agentIds()].sort());
  });
});
