import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The contract has to be implementable from an agent PACKAGE — the only reason
 * it moved out of `apps/cli/src/agents/command/types.ts`.
 *
 * So the check that matters is a dependency one: nothing here may reach back
 * into the app, and every third-party import must be declared. Neither is
 * caught by typechecking — `import type` erases at build, and an undeclared
 * dependency resolves through the workspace hoist in the dev tree while failing
 * for anyone installing this package on its own.
 */
const SRC = join(__dirname, '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

function specifiers(file: string): string[] {
  const src = readFileSync(join(SRC, file), 'utf8');
  return [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
}

describe('the CLI kit stands alone', () => {
  it('has source to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('imports nothing from apps/cli', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const spec of specifiers(f)) {
        // A relative path climbing out of the package, or a bare `apps/` path.
        if (spec.includes('apps/cli') || spec.startsWith('../')) offenders.push(`${f}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares every package it imports', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    const missing = new Set<string>();
    for (const f of files) {
      for (const spec of specifiers(f)) {
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0];
        if (name && !declared.has(name)) missing.add(`${f}: ${name}`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
