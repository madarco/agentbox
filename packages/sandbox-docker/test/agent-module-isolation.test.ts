import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No agent's module may import from another agent's module.
 *
 * `codex.ts`, `opencode.ts`, `seed.ts` and `shell-session.ts` all used to pull
 * `buildTermSafeTmuxExec` / `buildTmuxSessionArgs` / `CONTAINER_USER` out of
 * `claude.ts`, which quietly made Claude the shared module for the whole
 * package — including for `agentbox shell`, which has no agent at all.
 *
 * That is harmless while the three are siblings in one directory and fatal the
 * moment each becomes its own package: every agent package would take a
 * dependency on `@agentbox/agent-claude` to get a tmux flag, and the "an agent
 * is a package" claim would be false on arrival.
 *
 * Shared box plumbing belongs in `shared.ts`. If this test fails, that is where
 * the symbol goes — not into whichever agent happened to need it first.
 */

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sync', 'agents');

/** Module basenames that are one agent's implementation, not shared plumbing. */
const AGENT_MODULES = ['claude', 'codex', 'opencode'];

/**
 * `builtins.ts` is the one file allowed to import every agent: it is the
 * registration point that adapts the three shipped modules to
 * `AgentSyncModule`, and it exists precisely so no OTHER file has to import
 * them.
 *
 * It is a staging post. Each agent's arm leaves this file when that agent
 * becomes a package and the app registers it instead, so the exemption shrinks
 * to nothing rather than being permanent.
 */
const REGISTRATION_POINT = 'builtins.ts';

function sourceFiles(): string[] {
  return readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.ts'));
}

describe('agent modules are isolated from each other', () => {
  it('has agent modules to check (the glob can silently find nothing)', () => {
    const found = sourceFiles();
    for (const a of AGENT_MODULES) {
      expect(found, `missing ${a}.ts`).toContain(`${a}.ts`);
    }
    expect(found).toContain('shared.ts');
  });

  it('no module imports from another agent module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === REGISTRATION_POINT) continue;
      const self = file.replace(/\.ts$/, '');
      const src = readFileSync(join(AGENTS_DIR, file), 'utf8');
      for (const other of AGENT_MODULES) {
        if (other === self) continue;
        // `from './claude.js'` / `from "./codex.js"` — the relative sibling form.
        if (new RegExp(`from ['"]\\./${other}\\.js['"]`).test(src)) {
          offenders.push(`${file} imports from ${other}.ts`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shared.ts depends on no agent module and no package', () => {
    // It is the bottom of this package's agent layer: if it grows an import of
    // an agent module the cycle is back, just pointing the other way.
    const src = readFileSync(join(AGENTS_DIR, 'shared.ts'), 'utf8');
    for (const other of AGENT_MODULES) {
      expect(src, `shared.ts imports ${other}.ts`).not.toMatch(
        new RegExp(`from ['"]\\./${other}\\.js['"]`),
      );
    }
    expect(src, 'shared.ts should stay dependency-free').not.toMatch(/^import /m);
  });
});
