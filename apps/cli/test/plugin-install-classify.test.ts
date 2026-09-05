import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPluginInstall } from '../src/lib/plugin-install-root.js';

/** Real dirs on disk, so realpath/lstat behave as they will in production. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'agentbox-plugin-classify-'));
  const npmRoot = join(root, 'npm', 'node_modules');
  const pnpmRoot = join(root, 'pnpm', 'node_modules');
  mkdirSync(npmRoot, { recursive: true });
  mkdirSync(pnpmRoot, { recursive: true });
  return { root, roots: { npm: npmRoot, pnpm: pnpmRoot } };
}

function installed(root: string, pkg: string): string {
  const dir = join(root, pkg, 'dist');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'index.js');
  writeFileSync(entry, '');
  return entry;
}

describe('classifyPluginInstall', () => {
  it('recognises a plain npm-global install', () => {
    const { roots } = scratch();
    const entry = installed(roots.npm, 'agentbox-provider-x');
    expect(
      classifyPluginInstall({ packageName: 'agentbox-provider-x', resolvedEntry: entry, roots }),
    ).toEqual({ kind: 'npm' });
  });

  it('recognises a scoped package under the npm root', () => {
    const { roots } = scratch();
    const entry = installed(roots.npm, '@tenkicloud/agentbox-provider');
    expect(
      classifyPluginInstall({
        packageName: '@tenkicloud/agentbox-provider',
        resolvedEntry: entry,
        roots,
      }),
    ).toEqual({ kind: 'npm' });
  });

  // pnpm-global puts a symlink in the root pointing into .pnpm/<pkg>@<v>/…, so
  // only comparing REALPATHS on both sides lines the two up.
  it('follows pnpm-global indirection through .pnpm', () => {
    const { root, roots } = scratch();
    const store = join(root, 'pnpm', '.pnpm', 'agentbox-provider-x@1.0.0', 'node_modules');
    mkdirSync(store, { recursive: true });
    const entry = installed(store, 'agentbox-provider-x');
    symlinkSync(join(store, 'agentbox-provider-x'), join(roots.pnpm, 'agentbox-provider-x'));
    expect(
      classifyPluginInstall({ packageName: 'agentbox-provider-x', resolvedEntry: entry, roots }),
    ).toEqual({ kind: 'pnpm' });
  });

  // The case a `/node_modules/` substring heuristic gets wrong, and clobbers.
  it('reports an npm-linked dev checkout as linked, not npm', () => {
    const { root, roots } = scratch();
    const checkout = join(root, 'dev');
    mkdirSync(checkout, { recursive: true });
    const entry = installed(checkout, 'agentbox-provider-x');
    symlinkSync(join(checkout, 'agentbox-provider-x'), join(roots.npm, 'agentbox-provider-x'));
    expect(
      classifyPluginInstall({ packageName: 'agentbox-provider-x', resolvedEntry: entry, roots }),
    ).toEqual({ kind: 'linked' });
  });

  it('reports a plugin registered from a local path', () => {
    const { root, roots } = scratch();
    const entry = installed(join(root, 'elsewhere'), 'agentbox-provider-x');
    expect(
      classifyPluginInstall({ packageName: 'agentbox-provider-x', resolvedEntry: entry, roots }),
    ).toEqual({ kind: 'path' });
  });

  it('reports an unresolvable package as missing', () => {
    const { roots } = scratch();
    expect(
      classifyPluginInstall({ packageName: 'agentbox-provider-x', resolvedEntry: null, roots }),
    ).toEqual({ kind: 'missing' });
  });

  it('reports a stale entry path as missing rather than guessing', () => {
    const { root, roots } = scratch();
    expect(
      classifyPluginInstall({
        packageName: 'agentbox-provider-x',
        resolvedEntry: join(root, 'gone', 'dist', 'index.js'),
        roots,
      }),
    ).toEqual({ kind: 'missing' });
  });

  it('falls back to path when no package manager is on PATH', () => {
    const { root } = scratch();
    const entry = installed(join(root, 'elsewhere'), 'agentbox-provider-x');
    expect(
      classifyPluginInstall({
        packageName: 'agentbox-provider-x',
        resolvedEntry: entry,
        roots: { npm: null, pnpm: null },
      }),
    ).toEqual({ kind: 'path' });
  });
});
