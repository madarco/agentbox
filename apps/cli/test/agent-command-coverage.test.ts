import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentIds } from '@agentbox/sandbox-core';
import { describe, expect, it } from 'vitest';

/**
 * `fork` delegates to each agent's own create+teleport+attach command through a
 * literal map. With `AgentId` open the compiler cannot check that map against
 * the registry, and a missing arm only shows up as `fork --agent <new>` failing
 * for a user.
 *
 * Read from source rather than imported: `commands/fork.ts` pulls in all three
 * agent commands and their provider machinery, which is a heavy and
 * side-effectful import for one assertion about a table's keys.
 *
 * This whole test retires with the `agentCommand(spec)` factory, which builds
 * the map from the registry instead of listing it.
 */
describe('fork agent command map', () => {
  it('registers a command for every agent in the registry', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'fork.ts'), 'utf8');
    const block = src.match(/const AGENT_COMMAND: Record<string, Command> = \{([^}]*)\}/);
    expect(block, 'AGENT_COMMAND literal not found — was it renamed?').not.toBeNull();
    const keys = [...(block![1] ?? '').matchAll(/^\s*([a-z][\w-]*):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...agentIds()].sort());
  });
});
