import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_SPECS, builtinAgentIds, findAgentSpec } from '../src/index.js';

/**
 * The `./spec` entry of every agent package must stay dependency-free.
 *
 * This package sits BELOW `sandbox-core`, which everything depends on. An agent
 * package's `./spec` is imported from here; its main entry is not, and is free
 * to depend on `sandbox-core`, `sandbox-docker` and the rest. If a spec file
 * ever reaches for one of those, the graph closes into a cycle.
 *
 * That failure is invisible in the dev tree — pnpm symlinks resolve it happily —
 * and surfaces as a build-order or bundling failure, possibly only in the
 * published CLI. So it is asserted here rather than left to be discovered.
 *
 * The allowlist is the two leaves plus node builtins. Growing it is a design
 * decision, not a fix: whatever you were about to import belongs behind a spec
 * FIELD (data the agent declares) or in the agent's main entry (behavior).
 */

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED_PACKAGES = new Set(['@agentbox/core', '@agentbox/config']);

function agentPackageDirs(): string[] {
  return readdirSync(PACKAGES_DIR)
    .filter((d) => d.startsWith('agent-') && d !== 'agent-registry')
    .filter((d) => existsSync(join(PACKAGES_DIR, d, 'src', 'spec.ts')));
}

/** Every module specifier `src/spec.ts` imports. */
function specImports(pkgDir: string): string[] {
  const src = readFileSync(join(PACKAGES_DIR, pkgDir, 'src', 'spec.ts'), 'utf8');
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('agent ./spec entries stay importable from the bottom of the graph', () => {
  it('finds the agent packages (the scan can silently match nothing)', () => {
    const dirs = agentPackageDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const id of builtinAgentIds()) expect(dirs).toContain(`agent-${id}`);
  });

  it('imports only the dependency-free leaves and node builtins', () => {
    const offenders: string[] = [];
    for (const dir of agentPackageDirs()) {
      for (const spec of specImports(dir)) {
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        if (ALLOWED_PACKAGES.has(spec)) continue;
        offenders.push(`${dir}/src/spec.ts imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no dependency beyond those leaves in package.json', () => {
    // The import scan above misses a transitive pull through a relative file;
    // the manifest is the backstop.
    const offenders: string[] = [];
    for (const dir of agentPackageDirs()) {
      const pkg = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (dep.startsWith('@agentbox/') && !ALLOWED_PACKAGES.has(dep)) {
          offenders.push(`${dir} depends on ${dep}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the aggregated registry', () => {
  it('carries every built-in, in canonical order with claude first', () => {
    expect(builtinAgentIds()).toEqual(['claude', 'codex', 'opencode']);
  });

  it('resolves an agent by id and by wire alias', () => {
    expect(findAgentSpec('claude')?.id).toBe('claude');
    // Persisted queue jobs and box records still carry the frozen wire spelling.
    expect(findAgentSpec('claude-code')?.id).toBe('claude');
    expect(findAgentSpec('nope')).toBeUndefined();
  });

  it('every spec is JSON-serializable — no functions may creep in', () => {
    // The whole reason the data can live below sandbox-core is that it is data.
    // A function-valued field would still typecheck through `unknown` corners.
    for (const spec of AGENT_SPECS) {
      const walk = (v: unknown, path: string): void => {
        expect(typeof v, `${spec.id}: ${path} is a function`).not.toBe('function');
        if (v && typeof v === 'object') {
          for (const [k, child] of Object.entries(v)) walk(child, `${path}.${k}`);
        }
      };
      walk(spec, spec.id);
    }
  });
});
