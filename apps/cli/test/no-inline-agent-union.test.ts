import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard: no file may re-declare the set of shipped agents as an
 * inline union.
 *
 * `AgentId` is an open `string` (see `@agentbox/core`'s `sync/agent-kind.ts`),
 * which is a deliberate trade: the compiler no longer enumerates the sites a
 * newly-added agent misses. This test is what stands in its place. Before the
 * convergence there were ~35 such unions across eight differently-named types,
 * and each one was a place a fourth agent had to be added by hand — with nothing
 * failing if it wasn't.
 *
 * A source scan rather than a lint rule because it is one rule about one repo
 * fact, and it must fail in the same `pnpm test` run that would otherwise pass.
 *
 * If you are here because this test failed: import `AgentId` / `AgentMode` from
 * `@agentbox/core` instead of spelling the agents out. If the site genuinely
 * needs specific named agents (a fixture that creates three files, say), name
 * the fields concretely rather than typing them as an agent union.
 */

const REPO = join(__dirname, '..', '..', '..');

/**
 * A union is "the agent set spelled out" when two or more of its members are
 * agent names AND agents are the MAJORITY of it — which is what separates
 * `'claude' | 'codex' | 'opencode' | 'shell'` (the agent set plus a mode) from
 * `OpenInApp` in `commands/_open-in.ts`, whose `claude` / `codex` are the
 * DESKTOP APPS `Claude.app` / `Codex.app` sitting among herdr, cmux, vscode and
 * finder. A fourth agent does not belong in that one, so flagging it would train
 * people to ignore this test.
 */
const AGENT_LITERAL = /'(?:claude|claude-code|codex|opencode)'/g;
const UNION_CHAIN = /'[a-z-]+'(?:\s*\|\s*'[a-z-]+')+/g;

function isAgentSetUnion(chain: string): boolean {
  const members = chain.match(/'[a-z-]+'/g) ?? [];
  const agents = new Set(chain.match(AGENT_LITERAL) ?? []);
  return agents.size >= 2 && agents.size * 2 > members.length;
}

const ROOTS = [
  'apps/cli/src',
  'apps/hub/lib',
  'apps/hub/components',
  'apps/hub/app',
  'packages/core/src',
  'packages/config/src',
  'packages/ctl/src',
  'packages/relay/src',
  'packages/sandbox-core/src',
  'packages/sandbox-cloud/src',
  'packages/sandbox-docker/src',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Strip comments so prose about the agents doesn't read as a type. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('no inline agent unions', () => {
  const files = ROOTS.flatMap((r) => walk(join(REPO, r)));

  it('has source to scan (the walk itself can silently find nothing)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('nobody re-declares the agent set as a literal union', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const chain of src.match(UNION_CHAIN) ?? []) {
        if (isAgentSetUnion(chain)) offenders.push(`${file.slice(REPO.length + 1)}: ${chain}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
