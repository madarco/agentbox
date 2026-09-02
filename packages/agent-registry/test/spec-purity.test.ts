import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_SPECS, builtinAgentIds, findAgentSpec, visibleAgentIds } from '../src/index.js';

/**
 * This package must stay importable from the BOTTOM of the dependency graph.
 *
 * `sandbox-core` depends on it, and everything depends on `sandbox-core`. If a
 * spec file — or this package's manifest — ever reaches for `sandbox-core`,
 * `sandbox-docker` or an agent's behavior package, the graph closes and turbo
 * refuses to build the workspace. That already happened once, when the specs
 * lived in the agent packages behind a `./spec` subpath: entry points do not
 * split a node in a package graph.
 *
 * The allowlist is the two dependency-free leaves plus node builtins. Growing it
 * is a design decision, not a fix: whatever you were about to import belongs
 * behind a spec FIELD (data the agent declares) or in the agent's behavior
 * package.
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS_DIR = join(PKG_ROOT, 'src', 'specs');

const ALLOWED_PACKAGES = new Set(['@agentbox/core', '@agentbox/config']);

function specFiles(): string[] {
  return readdirSync(SPECS_DIR).filter((f) => f.endsWith('.ts'));
}

/** Every module specifier a spec file imports. */
function specImports(file: string): string[] {
  const src = readFileSync(join(SPECS_DIR, file), 'utf8');
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('the spec table stays importable from the bottom of the graph', () => {
  it('has a spec file per registered agent (the scan can silently match nothing)', () => {
    const files = specFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const id of builtinAgentIds()) expect(files).toContain(`${id}.ts`);
  });

  it('imports only the dependency-free leaves and node builtins', () => {
    const offenders: string[] = [];
    for (const file of specFiles()) {
      for (const spec of specImports(file)) {
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        if (ALLOWED_PACKAGES.has(spec)) continue;
        offenders.push(`specs/${file} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no dependency beyond those leaves in package.json', () => {
    // The import scan misses a transitive pull through a relative file, and the
    // manifest is what turbo actually reads to order the build — so this is the
    // check that would have caught the cycle before it was hit.
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const offenders = Object.keys(pkg.dependencies ?? {}).filter(
      (dep) => dep.startsWith('@agentbox/') && !ALLOWED_PACKAGES.has(dep),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the aggregated registry', () => {
  it('carries every built-in, in canonical order with claude first', () => {
    expect(builtinAgentIds()).toEqual(['claude', 'codex', 'opencode', 'pi', 'openclaw', 'example']);
  });

  it('hides the canary from the agents a user is offered', () => {
    // `example` is real to the machinery and absent from every picker.
    expect(visibleAgentIds()).toEqual(['claude', 'codex', 'opencode', 'pi', 'openclaw']);
    expect(findAgentSpec('example')?.hidden).toBe(true);
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
