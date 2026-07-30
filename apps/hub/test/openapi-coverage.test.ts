import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApi } from '../app/(dashboard)/api/v1/lib/openapi';

// The OpenAPI document is hand-authored (no zod/codegen convention in this repo),
// so it drifts silently when a route lands without a matching entry. This test is
// the "verification checklist asserts every route appears here" the openapi.ts
// header promises: it diffs the actual App-Router route files against the paths
// the document declares. Fails loudly on a new route that forgot its docs.

const HERE = dirname(fileURLToPath(import.meta.url));
const V1_DIR = join(HERE, '..', 'app', '(dashboard)', 'api', 'v1');

// These two routes SERVE the API description itself — the spec JSON and the
// Scalar docs page — rather than being documented API endpoints.
const SELF_DESCRIBING = new Set(['/openapi.json', '/docs']);

// dir segment -> OpenAPI path segment. `[id]`/`[action]` -> `{id}`/`{action}`;
// a catch-all `[...path]` -> `{path}`.
function segToPath(seg: string): string {
  const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return `{${catchAll[1]}}`;
  const dynamic = seg.match(/^\[(.+)\]$/);
  if (dynamic) return `{${dynamic[1]}}`;
  return seg;
}

// Walk the route tree, collecting the API path for every `route.ts`.
function collectRoutePaths(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...collectRoutePaths(join(dir, entry.name)));
    } else if (entry.name === 'route.ts') {
      const rel = relative(V1_DIR, dir);
      const apiPath = rel === '' ? '/' : '/' + rel.split('/').map(segToPath).join('/');
      out.push(apiPath);
    }
  }
  return out;
}

describe('OpenAPI route coverage', () => {
  it('documents every /api/v1 route (except the self-describing spec/docs pages)', () => {
    const spec = buildOpenApi();
    const documented = new Set(Object.keys(spec.paths as Record<string, unknown>));
    const routes = collectRoutePaths(V1_DIR).filter((p) => !SELF_DESCRIBING.has(p));

    const missing = routes.filter((p) => !documented.has(p)).sort();
    expect(missing, `undocumented routes in openapi.ts:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no documented path that no longer has a route file', () => {
    const spec = buildOpenApi();
    const documented = Object.keys(spec.paths as Record<string, unknown>);
    const routes = new Set(collectRoutePaths(V1_DIR));

    const stale = documented.filter((p) => !routes.has(p)).sort();
    expect(stale, `documented paths with no route file:\n${stale.join('\n')}`).toEqual([]);
  });
});
